-- =====================================================================
-- Absage im Deal-Panel für eine Buchung, die im Kontakt-Panel (ohne Deal)
-- entstanden ist: Das Deal-Panel zeigt auch Buchungen des Kontakts ohne Deal.
-- „Deal verloren“ braucht dann den Deal aus der Panel-Sitzung (p_deal_id,
-- vom Server gesetzt). Die Einladung wird dabei diesem Deal zugeordnet.
-- Neue Variante mit 6 Parametern; die bisherige (5 Parameter) ruft sie auf.
-- =====================================================================

create or replace function public.panel_cancel_booking(
  p_tenant_id     uuid,
  p_invitation_id uuid,
  p_mode          text,
  p_notify        boolean,
  p_lost_reason   text,
  p_deal_id       bigint
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv  public.invitations;
  b      public.bookings;
  v_deal bigint;
begin
  if auth.uid() is null or not app.is_member(p_tenant_id) then
    raise exception using errcode = 'P0001', message = 'TB:forbidden';
  end if;
  if p_mode is null or p_mode not in ('reinvite', 'lost') then
    raise exception using errcode = 'P0001', message = 'TB:invalid_input';
  end if;
  -- Sperrreihenfolge: erst invitations, dann bookings/slots
  select * into v_inv from public.invitations
   where id = p_invitation_id and tenant_id = p_tenant_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'TB:not_found';
  end if;
  -- Deal der Einladung; ohne Deal (Buchung aus dem Kontakt-Panel) der Deal des Panels
  v_deal := coalesce(v_inv.pipedrive_deal_id, p_deal_id);
  if p_mode = 'lost' and v_deal is null then
    raise exception using errcode = 'P0001', message = 'TB:invalid_input';
  end if;
  select * into b from public.bookings
   where invitation_id = v_inv.id and tenant_id = p_tenant_id and status = 'confirmed'
   order by created_at desc limit 1 for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'TB:not_found';
  end if;

  if p_mode = 'reinvite' then
    perform app.organizer_cancel_booking(b, true, false);
  else
    if v_inv.pipedrive_deal_id is null then
      update public.invitations set pipedrive_deal_id = v_deal where id = v_inv.id;
    end if;
    perform app.organizer_cancel_booking(b, coalesce(p_notify, false), true);
    insert into public.pipedrive_jobs (tenant_id, type, payload)
    values (p_tenant_id, 'deal_lost', pg_catalog.jsonb_build_object(
      'booking_id', b.id,
      'deal_id', v_deal,
      'user_id', auth.uid(),
      'reason', nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_lost_reason, '')), 255), '')));
  end if;
  return pg_catalog.jsonb_build_object('booking_id', b.id, 'email', b.email);
end
$$;

revoke all on function public.panel_cancel_booking(uuid, uuid, text, boolean, text, bigint) from public, anon, authenticated;
grant execute on function public.panel_cancel_booking(uuid, uuid, text, boolean, text, bigint) to authenticated, service_role;

-- bisherige Variante (laufender Code bis zum Deployment): ohne Deal des Panels
create or replace function public.panel_cancel_booking(
  p_tenant_id     uuid,
  p_invitation_id uuid,
  p_mode          text,
  p_notify        boolean default true,
  p_lost_reason   text default null
) returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.panel_cancel_booking(p_tenant_id, p_invitation_id, p_mode, p_notify, p_lost_reason, null::bigint)
$$;

revoke all on function public.panel_cancel_booking(uuid, uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function public.panel_cancel_booking(uuid, uuid, text, boolean, text) to authenticated, service_role;
