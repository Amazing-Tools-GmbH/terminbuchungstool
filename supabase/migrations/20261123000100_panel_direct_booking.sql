-- =====================================================================
-- Direktbuchung aus dem Deal-Panel: Der Vertrieb bucht einen Termin für den
-- Kontakt des Deals. Ablauf in EINER Transaktion:
--   1. Rechte prüfen (Mitglied des Mandanten)
--   2. offene Links desselben Kontakts im Deal ungültig machen
--   3. Zugang (invitations) anlegen – OHNE Einladungsmail; der Token kommt vom
--      Server und dient danach als Link zum Umbuchen/Stornieren in der Bestätigung
--   4. Buchen ausschließlich über public.book_slot() (Sperren, Prüfungen,
--      Bestätigung in die Outbox)
-- =====================================================================

create or replace function public.book_for_deal(
  p_tenant_id         uuid,
  p_slot_id           uuid,
  p_token             text,
  p_link_enc          text,
  p_name              text,
  p_email             text,
  p_organization_name text,
  p_deal_id           bigint,
  p_person_id         bigint,
  p_seats             integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_slot   public.slots;
  v_inv_id uuid;
  v_result jsonb;
begin
  if v_uid is null or not app.is_member(p_tenant_id) then
    raise exception using errcode = 'P0001', message = 'TB:forbidden';
  end if;
  if p_token is null or length(p_token) not between 20 and 200 or p_deal_id is null then
    raise exception using errcode = 'P0001', message = 'TB:invalid_input';
  end if;

  -- Termin bestimmen (ohne Sperre – book_slot sperrt in der Reihenfolge invitations, dann slots)
  select * into v_slot from public.slots s where s.id = p_slot_id and s.tenant_id = p_tenant_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'TB:slot_not_available';
  end if;

  -- Bereits gebucht? Dann nicht ein zweites Mal (Umbuchen über den Link in der Bestätigung)
  if exists (
    select 1 from public.invitations i
      join public.bookings b on b.invitation_id = i.id and b.status = 'confirmed'
     where i.tenant_id = p_tenant_id and i.pipedrive_deal_id = p_deal_id
       and lower(i.email) = lower(btrim(p_email)) and i.status = 'booked'
  ) then
    raise exception using errcode = 'P0001', message = 'TB:already_booked';
  end if;

  -- offene Links desselben Kontakts im Deal gelten nicht mehr
  update public.invitations
     set status = 'revoked'
   where tenant_id = p_tenant_id and pipedrive_deal_id = p_deal_id
     and lower(email) = lower(btrim(p_email)) and status = 'open';

  insert into public.invitations
    (tenant_id, event_id, token_hash, link_enc, name, email, organization_name, pipedrive_deal_id,
     pipedrive_person_id, allowed_slot_ids, expires_at, sent_at, created_by)
  values
    (p_tenant_id, v_slot.event_id, app.hash_token(p_token), p_link_enc, btrim(p_name), lower(btrim(p_email)),
     nullif(btrim(p_organization_name), ''), p_deal_id, p_person_id, null,
     -- Link aus der Bestätigung bleibt bis nach dem Termin gültig (mind. 30 Tage)
     greatest(v_slot.ends_at + interval '1 day', now() + interval '30 days'), null, v_uid)
  returning id into v_inv_id;

  v_result := public.book_slot(p_tenant_id, p_token, p_slot_id, p_seats, p_name, p_email, '{}', p_link_enc);
  return v_result || jsonb_build_object('invitation_id', v_inv_id);
end
$$;

revoke all on function public.book_for_deal(uuid, uuid, text, text, text, text, text, bigint, bigint, integer)
  from public, anon, authenticated;
grant execute on function public.book_for_deal(uuid, uuid, text, text, text, text, text, bigint, bigint, integer)
  to authenticated, service_role;
