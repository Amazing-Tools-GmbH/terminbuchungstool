-- =====================================================================
-- Weitere Teilnehmer mit eigener Einladung
--
-- Wer mehrere Plätze bucht (Kunde über den Buchungslink oder Vertrieb über
-- das Deal-Panel), kann für weitere Teilnehmer Name + E-Mail angeben und
-- ihnen eine eigene Einladung schicken. Jeder Teilnehmer bekommt einen
-- eigenen Link (/b/<token>, nur als Hash gespeichert), über den er NUR
-- seinen eigenen Platz absagen kann – wie bei einer Kalendereinladung.
-- Umbuchen/Stornieren der ganzen Buchung bleibt beim Hauptbucher.
--
-- * bookings.extra_attendees bleibt die Namensliste aller weiteren
--   Teilnehmer (Anzeige, Mails, Pipedrive). booking_guests enthält nur die
--   Teilnehmer mit eigener Einladung.
-- * Umbuchung: neue Buchung bekommt neue Teilnehmer-Zeilen (neue Links,
--   Mail „Buchung geändert“); wer nicht mehr dabei ist, bekommt eine Absage.
-- * Absage eines Teilnehmers: Platz wird frei (seats - 1), Name verschwindet
--   aus extra_attendees, Aktivität in Pipedrive wird aktualisiert.
-- * Mails laufen über die Outbox (Typ confirmation/cancellation mit
--   payload.guest_id), Links nur verschlüsselt im Payload.
-- =====================================================================

create table public.booking_guests (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  booking_id   uuid not null,
  name         text not null check (length(btrim(name)) between 1 and 200),
  email        text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
  token_hash   bytea not null unique,
  status       public.booking_status not null default 'confirmed',
  cancelled_at timestamptz,
  created_at   timestamptz not null default now(),
  unique (tenant_id, id),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  foreign key (tenant_id) references public.tenants (id) on delete cascade,
  foreign key (tenant_id, booking_id) references public.bookings (tenant_id, id)
);

create index booking_guests_booking_idx on public.booking_guests (booking_id);
create unique index booking_guests_one_email_per_booking
  on public.booking_guests (booking_id, email) where status = 'confirmed';

-- RLS: Mitglieder lesen (ohne token_hash); geschrieben wird nur über die
-- Funktionen unten. anon hat keinen Zugriff.
alter table public.booking_guests enable row level security;
revoke all on table public.booking_guests from anon, authenticated;
grant select (id, tenant_id, booking_id, name, email, status, cancelled_at, created_at)
  on public.booking_guests to authenticated;

create policy booking_guests_select on public.booking_guests
  for select to authenticated
  using (app.is_member(tenant_id));

-- ---------------------------------------------------------------------
-- Teilnehmer zu einer (neuen) Buchung anlegen + Einladungen in die Outbox.
-- p_guests: [{ "name", "email", "token", "link_enc" }]
-- p_previous: Teilnehmer-E-Mails der ersetzten Buchung (-> „geändert“)
-- ---------------------------------------------------------------------
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

    -- clock_timestamp(): Reihenfolge der Eingabe bleibt erhalten (now() ist je Transaktion gleich)
    insert into public.booking_guests (tenant_id, booking_id, name, email, token_hash, created_at)
    values (p_booking.tenant_id, p_booking.id, v_name, v_email, app.hash_token(v_token), clock_timestamp())
    returning id into v_id;

    insert into public.email_outbox (tenant_id, type, to_email, payload)
    values (p_booking.tenant_id, 'confirmation', v_email,
            jsonb_build_object('booking_id', p_booking.id, 'guest_id', v_id, 'link_enc', g ->> 'link_enc',
                               'changed', v_email = any (coalesce(p_previous, '{}'))));
  end loop;
end
$$;

-- Teilnehmer einer Buchung beenden (Storno/Umbuchung). Bei p_notify bekommen
-- alle (außer p_keep) eine Absage. Gibt die E-Mails der beendeten zurück.
create or replace function app.end_booking_guests(p_booking public.bookings, p_notify boolean, p_keep text[])
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  r      public.booking_guests;
  v_out  text[] := '{}';
begin
  for r in
    select * from public.booking_guests
     where booking_id = p_booking.id and status = 'confirmed'
     for update
  loop
    update public.booking_guests set status = 'cancelled', cancelled_at = now() where id = r.id;
    v_out := v_out || r.email;
    if p_notify and not (r.email = any (coalesce(p_keep, '{}'))) then
      insert into public.email_outbox (tenant_id, type, to_email, payload)
      values (r.tenant_id, 'cancellation', r.email, jsonb_build_object('booking_id', p_booking.id, 'guest_id', r.id));
    end if;
  end loop;
  return v_out;
end
$$;

revoke all on function app.add_booking_guests(public.bookings, jsonb, text[]) from public, anon, authenticated;
revoke all on function app.end_booking_guests(public.bookings, boolean, text[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- book_slot: wie bisher, zusätzlich p_guests (Teilnehmer mit Einladung)
-- ---------------------------------------------------------------------
drop function public.book_slot(uuid, text, uuid, integer, text, text, text[], text);

create function public.book_slot(
  p_tenant_id       uuid,
  p_token           text,
  p_slot_id         uuid,
  p_seats           integer,
  p_name            text,
  p_email           text,
  p_extra_attendees text[] default '{}',
  p_link_enc        text default null,
  p_guests          jsonb default '[]'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inv      public.invitations;
  v_tenant   public.tenants;
  v_event    public.events;
  v_slot     public.slots;
  v_old      public.bookings;
  v_old_slot public.slots;
  v_new      public.bookings;
  v_free     integer;
  v_new_id   uuid := gen_random_uuid();
  v_name     text := trim(coalesce(p_name, ''));
  v_email    text := lower(trim(coalesce(p_email, '')));
  v_extra    text[];
  v_prev     text[] := '{}';
  v_keep     text[];
begin
  if p_tenant_id is null or p_token is null or length(p_token) not between 20 and 200 then
    raise exception using errcode = 'P0001', message = 'TB:invitation_not_found';
  end if;

  -- 1) Einladung sperren (verhindert Doppel-Submits derselben Einladung)
  select * into v_inv
  from public.invitations i
  where i.token_hash = app.hash_token(p_token)
    and i.tenant_id = p_tenant_id
  for update;
  if not found or v_inv.status = 'revoked' then
    raise exception using errcode = 'P0001', message = 'TB:invitation_not_found';
  end if;
  if v_inv.expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'TB:invitation_expired';
  end if;

  select * into v_tenant from public.tenants where id = v_inv.tenant_id;
  select * into v_event  from public.events  where id = v_inv.event_id;
  if v_event.status <> 'published' then
    raise exception using errcode = 'P0001', message = 'TB:event_not_available';
  end if;

  -- 2) Eingaben prüfen (die App validiert zusätzlich mit zod)
  select coalesce(array_agg(trim(a)), '{}') into v_extra
  from unnest(coalesce(p_extra_attendees, '{}')) a
  where trim(a) <> '';
  if length(v_name) not between 1 and 200 then
    raise exception using errcode = 'P0001', message = 'TB:invalid_name';
  end if;
  if v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 then
    raise exception using errcode = 'P0001', message = 'TB:invalid_email';
  end if;
  if p_seats is null or p_seats < 1 then
    raise exception using errcode = 'P0001', message = 'TB:invalid_seats';
  end if;
  if cardinality(v_extra) > p_seats - 1
     or exists (select 1 from unnest(v_extra) a where length(a) > 200) then
    raise exception using errcode = 'P0001', message = 'TB:invalid_attendees';
  end if;

  -- 3) Bestehende Buchung? Dann ist das eine Umbuchung -> Frist prüfen
  select * into v_old
  from public.bookings b
  where b.invitation_id = v_inv.id and b.status = 'confirmed';
  if found then
    select * into v_old_slot from public.slots where id = v_old.slot_id;
    if now() >= v_old_slot.starts_at - make_interval(hours => v_tenant.change_deadline_hours) then
      raise exception using errcode = 'P0001', message = 'TB:change_deadline_passed';
    end if;
  end if;

  -- 4) Ziel-Slot sperren und prüfen
  select * into v_slot
  from public.slots s
  where s.id = p_slot_id
    and s.tenant_id = v_inv.tenant_id
    and s.event_id = v_inv.event_id
  for update;
  if not found
     or (v_inv.allowed_slot_ids is not null and not (p_slot_id = any (v_inv.allowed_slot_ids))) then
    raise exception using errcode = 'P0001', message = 'TB:slot_not_allowed';
  end if;
  if v_slot.status <> 'open' or v_slot.starts_at <= now() then
    raise exception using errcode = 'P0001', message = 'TB:slot_not_available';
  end if;

  -- 5) Freie Plätze unter Sperre zählen (eigene alte Buchung zählt nicht mit)
  v_free := v_slot.capacity - app.slot_booked_seats(v_slot.id, v_old.id);
  if p_seats > v_free then
    raise exception using errcode = 'P0001', message = 'TB:not_enough_seats',
      detail = json_build_object('free', greatest(v_free, 0))::text;
  end if;

  -- 6) Alte Buchung ersetzen, neue schreiben
  if v_old.id is not null then
    update public.bookings
       set status = 'cancelled', cancelled_at = now()
     where id = v_old.id;
    -- Teilnehmer, die bei der neuen Buchung nicht mehr dabei sind, bekommen eine Absage
    select coalesce(array_agg(lower(btrim(g ->> 'email'))), '{}') into v_keep
      from jsonb_array_elements(case when jsonb_typeof(p_guests) = 'array' then p_guests else '[]'::jsonb end) g;
    v_prev := app.end_booking_guests(v_old, true, v_keep);
  end if;

  insert into public.bookings (id, tenant_id, slot_id, invitation_id, name, email, seats, extra_attendees)
  values (v_new_id, v_inv.tenant_id, v_slot.id, v_inv.id, v_name, v_email, p_seats, v_extra)
  returning * into v_new;

  if v_old.id is not null then
    update public.bookings set replaced_by = v_new_id where id = v_old.id;
  end if;

  update public.invitations set status = 'booked' where id = v_inv.id;

  -- 7) Bestätigung in die Outbox (Versand asynchron, Buchung hängt nie daran)
  insert into public.email_outbox (tenant_id, type, to_email, payload)
  values (
    v_inv.tenant_id, 'confirmation', v_email,
    jsonb_build_object('booking_id', v_new_id, 'replaces_booking_id', v_old.id, 'link_enc', p_link_enc)
  );

  -- 8) Weitere Teilnehmer mit eigener Einladung
  perform app.add_booking_guests(v_new, p_guests, v_prev);

  return jsonb_build_object(
    'booking_id', v_new_id,
    'slot_id', v_slot.id,
    'seats', p_seats,
    'replaced_booking_id', v_old.id
  );
end
$$;

revoke all on function public.book_slot(uuid, text, uuid, integer, text, text, text[], text, jsonb) from public;
grant execute on function public.book_slot(uuid, text, uuid, integer, text, text, text[], text, jsonb)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- cancel_booking: wie bisher, zusätzlich Absage an alle Teilnehmer
-- ---------------------------------------------------------------------
create or replace function public.cancel_booking(p_tenant_id uuid, p_token text, p_link_enc text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inv     public.invitations;
  v_tenant  public.tenants;
  v_booking public.bookings;
  v_slot    public.slots;
begin
  if p_tenant_id is null or p_token is null or length(p_token) not between 20 and 200 then
    raise exception using errcode = 'P0001', message = 'TB:invitation_not_found';
  end if;

  select * into v_inv
  from public.invitations i
  where i.token_hash = app.hash_token(p_token)
    and i.tenant_id = p_tenant_id
  for update;
  if not found or v_inv.status = 'revoked' then
    raise exception using errcode = 'P0001', message = 'TB:invitation_not_found';
  end if;

  select * into v_booking
  from public.bookings b
  where b.invitation_id = v_inv.id and b.status = 'confirmed'
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'TB:no_active_booking';
  end if;

  select * into v_tenant from public.tenants where id = v_inv.tenant_id;
  select * into v_slot   from public.slots   where id = v_booking.slot_id;
  if now() >= v_slot.starts_at - make_interval(hours => v_tenant.change_deadline_hours) then
    raise exception using errcode = 'P0001', message = 'TB:change_deadline_passed';
  end if;

  update public.bookings set status = 'cancelled', cancelled_at = now() where id = v_booking.id;
  update public.invitations set status = 'cancelled' where id = v_inv.id;

  insert into public.email_outbox (tenant_id, type, to_email, payload)
  values (v_inv.tenant_id, 'cancellation', v_booking.email,
          jsonb_build_object('booking_id', v_booking.id, 'link_enc', p_link_enc));

  perform app.end_booking_guests(v_booking, true, '{}');

  return jsonb_build_object('booking_id', v_booking.id);
end
$$;

-- ---------------------------------------------------------------------
-- Ein Teilnehmer sagt über seinen eigenen Link für sich ab.
-- Sperrreihenfolge: invitations, dann bookings/booking_guests.
-- ---------------------------------------------------------------------
create or replace function public.cancel_guest(p_tenant_id uuid, p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_guest   public.booking_guests;
  v_booking public.bookings;
  v_tenant  public.tenants;
  v_slot    public.slots;
  v_pos     integer;
begin
  if p_tenant_id is null or p_token is null or length(p_token) not between 20 and 200 then
    raise exception using errcode = 'P0001', message = 'TB:invitation_not_found';
  end if;

  select * into v_guest
  from public.booking_guests g
  where g.token_hash = app.hash_token(p_token) and g.tenant_id = p_tenant_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'TB:invitation_not_found';
  end if;

  perform 1 from public.invitations i
    join public.bookings b on b.invitation_id = i.id
   where b.id = v_guest.booking_id
   for update of i;
  select * into v_booking from public.bookings where id = v_guest.booking_id for update;
  select * into v_guest from public.booking_guests where id = v_guest.id for update;

  if v_guest.status <> 'confirmed' or v_booking.status <> 'confirmed' then
    raise exception using errcode = 'P0001', message = 'TB:no_active_booking';
  end if;

  select * into v_tenant from public.tenants where id = v_booking.tenant_id;
  select * into v_slot   from public.slots   where id = v_booking.slot_id;
  if now() >= v_slot.starts_at - make_interval(hours => v_tenant.change_deadline_hours) then
    raise exception using errcode = 'P0001', message = 'TB:change_deadline_passed';
  end if;

  update public.booking_guests set status = 'cancelled', cancelled_at = now() where id = v_guest.id;

  -- Platz freigeben, Namen (erstes Vorkommen) aus der Teilnehmerliste nehmen
  v_pos := array_position(v_booking.extra_attendees, v_guest.name);
  update public.bookings
     set seats = seats - 1,
         extra_attendees = case when v_pos is null then extra_attendees
                                else extra_attendees[:v_pos - 1] || extra_attendees[v_pos + 1:] end
   where id = v_booking.id;

  -- Absage an den Teilnehmer, Hinweis an den Hauptbucher
  insert into public.email_outbox (tenant_id, type, to_email, payload)
  values (v_booking.tenant_id, 'cancellation', v_guest.email,
          jsonb_build_object('booking_id', v_booking.id, 'guest_id', v_guest.id));
  insert into public.email_outbox (tenant_id, type, to_email, payload)
  values (v_booking.tenant_id, 'confirmation', v_booking.email,
          jsonb_build_object('booking_id', v_booking.id, 'guest_cancelled', v_guest.name, 'link_enc',
                             (select i.link_enc from public.invitations i where i.id = v_booking.invitation_id)));

  return jsonb_build_object('booking_id', v_booking.id, 'guest_id', v_guest.id);
end
$$;

revoke all on function public.cancel_guest(uuid, text) from public;
grant execute on function public.cancel_guest(uuid, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Ansicht für den Link eines Teilnehmers. null = unbekannt.
-- ---------------------------------------------------------------------
create or replace function public.get_guest_context(p_tenant_id uuid, p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'guest', jsonb_build_object('name', g.name, 'email', g.email, 'status', g.status),
    'booker', jsonb_build_object('name', b.name, 'organization_name', i.organization_name),
    'event', jsonb_build_object('title', e.title),
    'booking', jsonb_build_object(
      'status', b.status,
      'starts_at', s.starts_at,
      'ends_at', s.ends_at,
      'location', coalesce(s.location, e.location),
      'change_until', s.starts_at - make_interval(hours => t.change_deadline_hours),
      'changeable', now() < s.starts_at - make_interval(hours => t.change_deadline_hours)
    )
  )
  from public.booking_guests g
  join public.bookings b    on b.id = g.booking_id
  join public.invitations i on i.id = b.invitation_id
  join public.slots s       on s.id = b.slot_id
  join public.events e      on e.id = s.event_id
  join public.tenants t     on t.id = g.tenant_id
  where p_tenant_id is not null and p_token is not null
    and length(p_token) between 20 and 200
    and g.token_hash = app.hash_token(p_token)
    and g.tenant_id = p_tenant_id
$$;

revoke all on function public.get_guest_context(uuid, text) from public;
grant execute on function public.get_guest_context(uuid, text) to anon, authenticated, service_role;

-- Mandant zu einem Link: Buchungslink ODER Link eines Teilnehmers
create or replace function public.resolve_tenant_by_token(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.resolve_tenant(t.slug, null)
  from public.tenants t
  where p_token is not null
    and length(p_token) between 20 and 200
    and t.id = coalesce(
      (select i.tenant_id from public.invitations i where i.token_hash = app.hash_token(p_token)),
      (select g.tenant_id from public.booking_guests g where g.token_hash = app.hash_token(p_token))
    )
$$;

-- ---------------------------------------------------------------------
-- Buchungsseite: Teilnehmer der aktiven Buchung (zum Vorbelegen beim Ändern)
-- ---------------------------------------------------------------------
create or replace function public.get_booking_guests(p_tenant_id uuid, p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('name', g.name, 'email', g.email) order by g.created_at, g.id), '[]'::jsonb)
  from public.invitations i
  join public.bookings b       on b.invitation_id = i.id and b.status = 'confirmed'
  join public.booking_guests g on g.booking_id = b.id and g.status = 'confirmed'
  where p_tenant_id is not null and p_token is not null
    and length(p_token) between 20 and 200
    and i.token_hash = app.hash_token(p_token)
    and i.tenant_id = p_tenant_id
    and i.status <> 'revoked'
$$;

revoke all on function public.get_booking_guests(uuid, text) from public;
grant execute on function public.get_booking_guests(uuid, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Direktbuchung aus dem Panel: mit Teilnehmern
-- ---------------------------------------------------------------------
drop function public.book_for_deal(uuid, uuid, text, text, text, text, text, bigint, bigint, integer);

create function public.book_for_deal(
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
-- Pipedrive: Aktivität auch aktualisieren, wenn sich die Plätze ändern
-- (Absage eines Teilnehmers)
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
begin
  select * into b from public.bookings where id = new.id;
  if not found then
    return null;
  end if;
  select i.pipedrive_deal_id into v_deal from public.invitations i where i.id = b.invitation_id;
  if v_deal is null then
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

create constraint trigger bookings_pipedrive_seats
  after update of seats on public.bookings
  deferrable initially deferred
  for each row execute function app.queue_booking_pipedrive_job();
