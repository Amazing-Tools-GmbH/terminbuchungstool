-- =====================================================================
-- Absage im Panel (Deal bzw. Kontakt) durch den Vertrieb:
--   reinvite  Buchung stornieren, Link bleibt gültig; der Kunde bekommt die
--             Absage mit seinem Link, um einen neuen Termin zu wählen.
--   lost      Buchung stornieren, Link gesperrt; Absage an den Kunden nur
--             mit p_notify (ohne Link); Deal in Pipedrive auf „verloren“
--             (Auftrag deal_lost, nur mit Deal).
-- Alle aktiven Mitglieder (auch sales) – wie Einladen/Buchen im Panel. Die
-- Zuordnung Einladung ↔ aktueller Deal/Kontakt prüft der Server (Panel-Sitzung).
-- Pipedrive-Aktivität löschen + Notiz übernimmt wie immer cancel_activity.
-- =====================================================================

alter table public.pipedrive_jobs drop constraint if exists pipedrive_jobs_type_check;
alter table public.pipedrive_jobs add constraint pipedrive_jobs_type_check
  check (type in ('booking_activity', 'cancel_activity', 'invitation_note', 'link_contact', 'deal_lost'));

create or replace function public.panel_cancel_booking(
  p_tenant_id     uuid,
  p_invitation_id uuid,
  p_mode          text,
  p_notify        boolean default true,
  p_lost_reason   text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.invitations;
  b     public.bookings;
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
  if p_mode = 'lost' and v_inv.pipedrive_deal_id is null then
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
    perform app.organizer_cancel_booking(b, coalesce(p_notify, false), true);
    insert into public.pipedrive_jobs (tenant_id, type, payload)
    values (p_tenant_id, 'deal_lost', pg_catalog.jsonb_build_object(
      'booking_id', b.id,
      'deal_id', v_inv.pipedrive_deal_id,
      'user_id', auth.uid(),
      'reason', nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_lost_reason, '')), 255), '')));
  end if;
  return pg_catalog.jsonb_build_object('booking_id', b.id, 'email', b.email);
end
$$;

revoke all on function public.panel_cancel_booking(uuid, uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function public.panel_cancel_booking(uuid, uuid, text, boolean, text) to authenticated, service_role;
