-- =====================================================================
-- Admin: Buchungen, Termine und Events pflegen (owner/admin)
--   * Buchung durch das Team stornieren
--   * Termin verschieben (Datum/Uhrzeit/Ort) oder absagen
--   * Event löschen (ohne Buchungen: wirklich löschen; mit Buchungen:
--     Buchungen stornieren, Links ungültig, Termine abgesagt, Event archiviert)
-- Wie im Kalender: p_notify entscheidet, ob Gebuchte (und eingeladene weitere
-- Teilnehmer) eine Mail bekommen. Mails nur über die Outbox, Pipedrive über
-- pipedrive_jobs. Sperrreihenfolge: invitations, dann slots, dann bookings.
-- =====================================================================

-- Link der weiteren Teilnehmer verschlüsselt merken (für Mails bei Änderungen
-- durch den Veranstalter); für authenticated nicht lesbar (Spaltenrechte)
alter table public.booking_guests add column link_enc text;

create or replace function app.add_booking_guests(
  p_booking   public.bookings,
  p_guests    jsonb,
  p_previous  text[]
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  g        jsonb;
  v_name   text;
  v_email  text;
  v_token  text;
  v_id     uuid;
  v_seen   text[] := '{}';
begin
  if p_guests is null or jsonb_typeof(p_guests) <> 'array' then
    return;
  end if;
  if jsonb_array_length(p_guests) > cardinality(p_booking.extra_attendees) then
    raise exception using errcode = 'P0001', message = 'TB:invalid_attendees';
  end if;

  for g in select * from jsonb_array_elements(p_guests) loop
    v_name  := btrim(coalesce(g ->> 'name', ''));
    v_email := lower(btrim(coalesce(g ->> 'email', '')));
    v_token := g ->> 'token';
    if length(v_name) not between 1 and 200 or not (v_name = any (p_booking.extra_attendees)) then
      raise exception using errcode = 'P0001', message = 'TB:invalid_attendees';
    end if;
    if v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254
       or v_email = p_booking.email or v_email = any (v_seen) then
      raise exception using errcode = 'P0001', message = 'TB:invalid_guest_email';
    end if;
    if v_token is null or length(v_token) not between 20 and 200 then
      raise exception using errcode = 'P0001', message = 'TB:invalid_input';
    end if;
    v_seen := v_seen || v_email;

    insert into public.booking_guests (tenant_id, booking_id, name, email, token_hash, link_enc, created_at)
    values (p_booking.tenant_id, p_booking.id, v_name, v_email, app.hash_token(v_token), g ->> 'link_enc', clock_timestamp())
    returning id into v_id;

    insert into public.email_outbox (tenant_id, type, to_email, payload)
    values (p_booking.tenant_id, 'confirmation', v_email,
            jsonb_build_object('booking_id', p_booking.id, 'guest_id', v_id, 'link_enc', g ->> 'link_enc',
                               'changed', v_email = any (coalesce(p_previous, '{}'))));
  end loop;
end
$$;

revoke all on function app.add_booking_guests(public.bookings, jsonb, text[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Interne Bausteine (nur über die public-Funktionen unten erreichbar)
-- ---------------------------------------------------------------------

-- Eine Buchung durch den Veranstalter stornieren (Aufrufer hält die Sperren)
create or replace function app.organizer_cancel_booking(p_booking public.bookings, p_notify boolean, p_revoke boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link text;
  g      public.booking_guests;
begin
  update public.bookings set status = 'cancelled', cancelled_at = now() where id = p_booking.id;
  -- Link bleibt gültig (Kunde kann neu wählen), außer das Event wird gelöscht
  update public.invitations
     set status = case when p_revoke then 'revoked'::public.invitation_status else 'cancelled'::public.invitation_status end
   where id = p_booking.invitation_id
  returning case when p_revoke then null else link_enc end into v_link;

  for g in select * from public.booking_guests where booking_id = p_booking.id and status = 'confirmed' for update loop
    update public.booking_guests set status = 'cancelled', cancelled_at = now() where id = g.id;
    if p_notify then
      insert into public.email_outbox (tenant_id, type, to_email, payload)
      values (g.tenant_id, 'cancellation', g.email, jsonb_build_object('booking_id', p_booking.id, 'guest_id', g.id, 'by_organizer', true));
    end if;
  end loop;

  if p_notify then
    insert into public.email_outbox (tenant_id, type, to_email, payload)
    values (p_booking.tenant_id, 'cancellation', p_booking.email,
            jsonb_build_object('booking_id', p_booking.id, 'link_enc', v_link, 'by_organizer', true));
  end if;
end
$$;

revoke all on function app.organizer_cancel_booking(public.bookings, boolean, boolean) from public, anon, authenticated;

create or replace function app.require_manager(p_tenant_id uuid) returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not app.is_member(p_tenant_id, array['owner', 'admin']::public.member_role[]) then
    raise exception using errcode = 'P0001', message = 'TB:forbidden';
  end if;
end
$$;

revoke all on function app.require_manager(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Buchung durch das Team stornieren
-- ---------------------------------------------------------------------
create or replace function public.admin_cancel_booking(p_tenant_id uuid, p_booking_id uuid, p_notify boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings;
begin
  perform app.require_manager(p_tenant_id);
  perform 1 from public.invitations i join public.bookings x on x.invitation_id = i.id
   where x.id = p_booking_id and x.tenant_id = p_tenant_id for update of i;
  select * into b from public.bookings where id = p_booking_id and tenant_id = p_tenant_id for update;
  if not found or b.status <> 'confirmed' then
    raise exception using errcode = 'P0001', message = 'TB:not_found';
  end if;
  perform app.organizer_cancel_booking(b, coalesce(p_notify, false), false);
end
$$;

-- ---------------------------------------------------------------------
-- Termin verschieben bzw. Ort ändern. Gebuchte bleiben gebucht; mit
-- p_notify bekommen sie (und eingeladene Teilnehmer) die geänderte Buchung.
-- ---------------------------------------------------------------------
create or replace function public.admin_update_slot(
  p_tenant_id uuid,
  p_slot_id   uuid,
  p_starts_at timestamptz,
  p_ends_at   timestamptz,
  p_location  text,
  p_notify    boolean
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  s       public.slots;
  b       public.bookings;
  g       public.booking_guests;
  v_link  text;
  v_deal  bigint;
  v_count integer := 0;
  v_moved boolean;
begin
  perform app.require_manager(p_tenant_id);
  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    raise exception using errcode = 'P0001', message = 'TB:invalid_input';
  end if;
  perform 1 from public.invitations i join public.bookings x on x.invitation_id = i.id
   where x.slot_id = p_slot_id and x.tenant_id = p_tenant_id and x.status = 'confirmed' for update of i;
  select * into s from public.slots where id = p_slot_id and tenant_id = p_tenant_id for update;
  if not found or s.status = 'cancelled' then
    raise exception using errcode = 'P0001', message = 'TB:not_found';
  end if;
  v_moved := s.starts_at <> p_starts_at or s.ends_at <> p_ends_at;
  if v_moved and p_starts_at <= now() then
    raise exception using errcode = 'P0001', message = 'TB:slot_in_past';
  end if;

  update public.slots
     set starts_at = p_starts_at, ends_at = p_ends_at, location = nullif(btrim(coalesce(p_location, '')), '')
   where id = s.id;

  -- nichts Relevantes geändert -> keine Mails/Einträge
  if not v_moved and coalesce(s.location, '') = coalesce(nullif(btrim(coalesce(p_location, '')), ''), '') then
    return 0;
  end if;

  for b in select * from public.bookings where slot_id = s.id and status = 'confirmed' for update loop
    v_count := v_count + 1;
    select i.link_enc, i.pipedrive_deal_id into v_link, v_deal from public.invitations i where i.id = b.invitation_id;
    if v_deal is not null then
      insert into public.pipedrive_jobs (tenant_id, type, payload)
      values (b.tenant_id, 'booking_activity', jsonb_build_object('booking_id', b.id));
    end if;
    if p_notify then
      insert into public.email_outbox (tenant_id, type, to_email, payload)
      values (b.tenant_id, 'confirmation', b.email,
              jsonb_build_object('booking_id', b.id, 'link_enc', v_link, 'by_organizer', true));
      for g in select * from public.booking_guests where booking_id = b.id and status = 'confirmed' loop
        insert into public.email_outbox (tenant_id, type, to_email, payload)
        values (g.tenant_id, 'confirmation', g.email,
                jsonb_build_object('booking_id', b.id, 'guest_id', g.id, 'link_enc', g.link_enc, 'changed', true, 'by_organizer', true));
      end loop;
    end if;
  end loop;
  return v_count;
end
$$;

-- ---------------------------------------------------------------------
-- Termin absagen: Buchungen stornieren (mit/ohne Mail). Ohne jemals eine
-- Buchung wird der Termin gelöscht (z. B. versehentlich angelegt).
-- ---------------------------------------------------------------------
create or replace function public.admin_cancel_slot(p_tenant_id uuid, p_slot_id uuid, p_notify boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  s       public.slots;
  b       public.bookings;
  v_count integer := 0;
begin
  perform app.require_manager(p_tenant_id);
  perform 1 from public.invitations i join public.bookings x on x.invitation_id = i.id
   where x.slot_id = p_slot_id and x.tenant_id = p_tenant_id for update of i;
  select * into s from public.slots where id = p_slot_id and tenant_id = p_tenant_id for update;
  if not found or s.status = 'cancelled' then
    raise exception using errcode = 'P0001', message = 'TB:not_found';
  end if;

  if not exists (select 1 from public.bookings where slot_id = s.id) then
    delete from public.slots where id = s.id;
    return 0;
  end if;

  for b in select * from public.bookings where slot_id = s.id and status = 'confirmed' for update loop
    v_count := v_count + 1;
    perform app.organizer_cancel_booking(b, coalesce(p_notify, false), false);
  end loop;
  update public.slots set status = 'cancelled' where id = s.id;
  return v_count;
end
$$;

-- ---------------------------------------------------------------------
-- Event löschen. Ohne Buchungen: Event samt Terminen und Links wirklich
-- löschen. Mit Buchungen: alle Buchungen stornieren (Mail nur mit
-- p_notify), alle Links ungültig, Termine abgesagt, Event archiviert –
-- die Historie (Buchungsliste, Pipedrive) bleibt nachvollziehbar.
-- ---------------------------------------------------------------------
create or replace function public.admin_delete_event(p_tenant_id uuid, p_event_id uuid, p_notify boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e       public.events;
  b       public.bookings;
  v_count integer := 0;
begin
  perform app.require_manager(p_tenant_id);
  perform 1 from public.invitations where event_id = p_event_id and tenant_id = p_tenant_id for update;
  perform 1 from public.slots where event_id = p_event_id and tenant_id = p_tenant_id for update;
  select * into e from public.events where id = p_event_id and tenant_id = p_tenant_id for update;
  if not found or e.status = 'archived' then
    raise exception using errcode = 'P0001', message = 'TB:not_found';
  end if;

  if not exists (select 1 from public.bookings x join public.slots s on s.id = x.slot_id where s.event_id = e.id) then
    delete from public.events where id = e.id; -- Termine und Links per Kaskade
    return jsonb_build_object('deleted', true, 'cancelled', 0);
  end if;

  for b in
    select x.* from public.bookings x join public.slots s on s.id = x.slot_id
     where s.event_id = e.id and x.status = 'confirmed'
     for update of x
  loop
    v_count := v_count + 1;
    perform app.organizer_cancel_booking(b, coalesce(p_notify, false), true);
  end loop;
  update public.invitations set status = 'revoked' where event_id = e.id and status <> 'revoked';
  update public.slots set status = 'cancelled' where event_id = e.id and status <> 'cancelled';
  update public.events set status = 'archived' where id = e.id;
  return jsonb_build_object('deleted', false, 'cancelled', v_count);
end
$$;

revoke all on function public.admin_cancel_booking(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.admin_update_slot(uuid, uuid, timestamptz, timestamptz, text, boolean) from public, anon, authenticated;
revoke all on function public.admin_cancel_slot(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.admin_delete_event(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.admin_cancel_booking(uuid, uuid, boolean) to authenticated, service_role;
grant execute on function public.admin_update_slot(uuid, uuid, timestamptz, timestamptz, text, boolean) to authenticated, service_role;
grant execute on function public.admin_cancel_slot(uuid, uuid, boolean) to authenticated, service_role;
grant execute on function public.admin_delete_event(uuid, uuid, boolean) to authenticated, service_role;
