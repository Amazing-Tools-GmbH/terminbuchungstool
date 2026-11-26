-- =====================================================================
-- Panel im Kontakt (Person): Direktbuchung ohne Deal, nur mit Kontakt.
-- book_for_deal akzeptiert p_deal_id = null, wenn ein Kontakt angegeben ist;
-- „bereits gebucht“ und das Ungültigmachen alter Links beziehen sich dann
-- auf den Kontakt (Einladungen ohne Deal). Rechte unverändert.
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
  p_seats             integer,
  p_extra_attendees   text[] default '{}',
  p_guests            jsonb default '[]'
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
  if p_token is null or length(p_token) not between 20 and 200 or (p_deal_id is null and p_person_id is null) then
    raise exception using errcode = 'P0001', message = 'TB:invalid_input';
  end if;

  -- Termin bestimmen (ohne Sperre – book_slot sperrt in der Reihenfolge invitations, dann slots)
  select * into v_slot from public.slots s where s.id = p_slot_id and s.tenant_id = p_tenant_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'TB:slot_not_available';
  end if;

  -- Bereits gebucht? Dann nicht ein zweites Mal (Änderungen nur durch das Team).
  -- Bereich: derselbe Deal bzw. – im Kontakt-Panel ohne Deal – derselbe Kontakt
  if exists (
    select 1 from public.invitations i
      join public.bookings b on b.invitation_id = i.id and b.status = 'confirmed'
     where i.tenant_id = p_tenant_id
       and ((p_deal_id is not null and i.pipedrive_deal_id = p_deal_id)
         or (p_deal_id is null and i.pipedrive_deal_id is null and i.pipedrive_person_id = p_person_id))
       and lower(i.email) = lower(btrim(p_email)) and i.status = 'booked'
  ) then
    raise exception using errcode = 'P0001', message = 'TB:already_booked';
  end if;

  -- offene Links desselben Kontakts im Deal gelten nicht mehr
  update public.invitations
     set status = 'revoked'
   where tenant_id = p_tenant_id
     and ((p_deal_id is not null and pipedrive_deal_id = p_deal_id)
       or (p_deal_id is null and pipedrive_deal_id is null and pipedrive_person_id = p_person_id))
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

  v_result := public.book_slot(p_tenant_id, p_token, p_slot_id, p_seats, p_name, p_email,
                               coalesce(p_extra_attendees, '{}'), p_link_enc, coalesce(p_guests, '[]'::jsonb));
  return v_result || jsonb_build_object('invitation_id', v_inv_id);
end
$$;

revoke all on function public.book_for_deal(uuid, uuid, text, text, text, text, text, bigint, bigint, integer, text[], jsonb)
  from public, anon, authenticated;
grant execute on function public.book_for_deal(uuid, uuid, text, text, text, text, text, bigint, bigint, integer, text[], jsonb)
  to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Pipedrive-Aufträge auch für Buchungen ohne Deal (nur Kontakt)
-- ---------------------------------------------------------------------
create or replace function app.queue_booking_pipedrive_job()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  v_deal bigint;
  v_person bigint;
begin
  select * into b from public.bookings where id = new.id;
  if not found then
    return null;
  end if;
  select i.pipedrive_deal_id, i.pipedrive_person_id into v_deal, v_person from public.invitations i where i.id = b.invitation_id;
  -- Einträge am Deal bzw. (Panel im Kontakt) nur am Kontakt
  if v_deal is null and v_person is null then
    return null;
  end if;

  if tg_op = 'INSERT' and b.status = 'confirmed' then
    insert into public.pipedrive_jobs (tenant_id, type, payload)
    values (b.tenant_id, 'booking_activity', pg_catalog.jsonb_build_object('booking_id', b.id));
  elsif tg_op = 'UPDATE' and tg_name = 'bookings_pipedrive_seats' then
    if b.status = 'confirmed' and old.seats is distinct from new.seats then
      insert into public.pipedrive_jobs (tenant_id, type, payload)
      values (b.tenant_id, 'booking_activity', pg_catalog.jsonb_build_object('booking_id', b.id));
    end if;
  elsif tg_op = 'UPDATE' and b.status = 'cancelled' and old.status = 'confirmed' and b.replaced_by is null then
    insert into public.pipedrive_jobs (tenant_id, type, payload)
    values (b.tenant_id, 'cancel_activity', pg_catalog.jsonb_build_object('booking_id', b.id));
  end if;
  return null;
end
$$;
