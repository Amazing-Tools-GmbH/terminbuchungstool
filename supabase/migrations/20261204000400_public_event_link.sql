-- =====================================================================
-- Öffentlicher Event-Link: Jeder mit dem Link kann einen Termin des Events
-- buchen (Name, E-Mail, Firma) – ohne persönliche Einladung. Die Buchung
-- legt eine Einladung (source = 'public') mit eigenem persönlichen Link an
-- und läuft wie jede Buchung über public.book_slot. Danach sucht ein
-- Pipedrive-Auftrag (link_contact) den Kontakt per E-Mail und dessen offenen
-- Deal (Dublettencheck) bzw. legt Kontakt + Deal an (Ziel: tenants.
-- new_deal_pipeline_id/new_deal_stage_id) und trägt dann die Aktivität ein.
-- Link: /b/<token>, in der DB nur als Hash (+ verschlüsselt fürs Admin).
-- =====================================================================

alter table public.events
  add column public_token_hash bytea unique check (public_token_hash is null or length(public_token_hash) = 32),
  add column public_link_enc text;

alter table public.invitations
  add column source text not null default 'invite' check (source in ('invite', 'public'));

alter table public.pipedrive_jobs drop constraint if exists pipedrive_jobs_type_check;
alter table public.pipedrive_jobs add constraint pipedrive_jobs_type_check
  check (type in ('booking_activity', 'cancel_activity', 'invitation_note', 'link_contact'));

-- ---------------------------------------------------------------------
-- Mandant zu einem Link: Buchungslink, Link eines Teilnehmers oder
-- öffentlicher Event-Link
-- ---------------------------------------------------------------------
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
      (select g.tenant_id from public.booking_guests g where g.token_hash = app.hash_token(p_token)),
      (select e.tenant_id from public.events e where e.public_token_hash = app.hash_token(p_token))
    )
$$;

-- ---------------------------------------------------------------------
-- Ansicht für den öffentlichen Event-Link (null = unbekannt/nicht aktiv)
-- ---------------------------------------------------------------------
create or replace function public.get_public_event_context(p_tenant_id uuid, p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_event public.events;
  v_slots jsonb;
begin
  if p_tenant_id is null or p_token is null or length(p_token) not between 20 and 200 then
    return null;
  end if;
  select * into v_event from public.events e
   where e.public_token_hash = app.hash_token(p_token) and e.tenant_id = p_tenant_id;
  if not found then
    return null;
  end if;

  select coalesce(jsonb_agg(x.j order by x.starts_at), '[]'::jsonb) into v_slots
  from (
    select s.starts_at,
      jsonb_build_object(
        'id', s.id,
        'starts_at', s.starts_at,
        'ends_at', s.ends_at,
        'capacity', case when v_event.show_seats then s.capacity end,
        'booked', case when v_event.show_seats then bk.booked end,
        'free', case when v_event.show_seats then greatest(s.capacity - bk.booked, 0)
                     else least(greatest(s.capacity - bk.booked, 0), 10) end,
        'own_seats', 0,
        'location', coalesce(s.location, v_event.location),
        'status', s.status,
        'bookable', s.status = 'open' and s.starts_at > now() and s.capacity - bk.booked > 0
      ) as j
    from public.slots s
    cross join lateral (select app.slot_booked_seats(s.id) as booked) bk
    where s.event_id = v_event.id and s.status <> 'cancelled' and s.ends_at > now()
  ) x;

  return jsonb_build_object(
    'event', jsonb_build_object(
      'id', v_event.id,
      'title', v_event.title,
      'description', v_event.description,
      'intro_text', v_event.intro_text,
      'location', v_event.location,
      'status', v_event.status,
      'show_seats', v_event.show_seats
    ),
    'slots', v_slots
  );
end
$$;

revoke all on function public.get_public_event_context(uuid, text) from public;
grant execute on function public.get_public_event_context(uuid, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Buchen über den öffentlichen Event-Link: Einladung (source public) mit
-- eigenem persönlichen Link anlegen, dann public.book_slot. Dieselbe
-- E-Mail kann ein Event nur einmal öffentlich buchen.
-- ---------------------------------------------------------------------
create or replace function public.book_public(
  p_tenant_id         uuid,
  p_event_token       text,
  p_token             text,
  p_link_enc          text,
  p_slot_id           uuid,
  p_seats             integer,
  p_name              text,
  p_email             text,
  p_organization_name text,
  p_extra_attendees   text[] default '{}',
  p_guests            jsonb default '[]'
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event  public.events;
  v_slot   public.slots;
  v_inv_id uuid;
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_result jsonb;
begin
  if p_tenant_id is null or p_event_token is null or length(p_event_token) not between 20 and 200
     or p_token is null or length(p_token) not between 20 and 200 then
    raise exception using errcode = 'P0001', message = 'TB:invitation_not_found';
  end if;
  select * into v_event from public.events e
   where e.public_token_hash = app.hash_token(p_event_token) and e.tenant_id = p_tenant_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'TB:invitation_not_found';
  end if;
  if v_event.status <> 'published' then
    raise exception using errcode = 'P0001', message = 'TB:event_not_available';
  end if;
  select * into v_slot from public.slots s where s.id = p_slot_id and s.event_id = v_event.id and s.tenant_id = p_tenant_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'TB:slot_not_available';
  end if;
  if v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 320 then
    raise exception using errcode = 'P0001', message = 'TB:invalid_email';
  end if;
  if length(btrim(coalesce(p_name, ''))) not between 1 and 200 then
    raise exception using errcode = 'P0001', message = 'TB:invalid_name';
  end if;
  -- dieselbe E-Mail bucht dieses Event nur einmal öffentlich
  if exists (
    select 1 from public.invitations i
      join public.bookings b on b.invitation_id = i.id and b.status = 'confirmed'
     where i.tenant_id = p_tenant_id and i.event_id = v_event.id and i.source = 'public' and i.email = v_email
  ) then
    raise exception using errcode = 'P0001', message = 'TB:already_booked';
  end if;

  insert into public.invitations
    (tenant_id, event_id, token_hash, link_enc, name, email, organization_name, allowed_slot_ids, expires_at, source)
  values
    (p_tenant_id, v_event.id, app.hash_token(p_token), p_link_enc, btrim(p_name), v_email,
     nullif(left(btrim(coalesce(p_organization_name, '')), 200), ''), null,
     greatest(v_slot.ends_at + interval '1 day', now() + interval '30 days'), 'public')
  returning id into v_inv_id;

  v_result := public.book_slot(p_tenant_id, p_token, p_slot_id, p_seats, p_name, v_email,
                               coalesce(p_extra_attendees, '{}'), p_link_enc, coalesce(p_guests, '[]'::jsonb));
  return v_result || jsonb_build_object('invitation_id', v_inv_id);
end
$$;

revoke all on function public.book_public(uuid, text, text, text, uuid, integer, text, text, text, text[], jsonb) from public;
grant execute on function public.book_public(uuid, text, text, text, uuid, integer, text, text, text, text[], jsonb)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Pipedrive-Aufträge: öffentliche Buchung ohne Kontakt -> link_contact
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
  v_source text;
begin
  select * into b from public.bookings where id = new.id;
  if not found then
    return null;
  end if;
  select i.pipedrive_deal_id, i.pipedrive_person_id, i.source into v_deal, v_person, v_source
    from public.invitations i where i.id = b.invitation_id;
  -- Einträge am Deal bzw. (Panel im Kontakt) nur am Kontakt
  if v_deal is null and v_person is null then
    -- öffentlicher Event-Link: erst Kontakt/Deal in Pipedrive finden bzw. anlegen
    -- (Auftrag link_contact; der legt danach die Aktivität an)
    if v_source = 'public' and tg_op = 'INSERT' and b.status = 'confirmed' then
      insert into public.pipedrive_jobs (tenant_id, type, payload)
      values (b.tenant_id, 'link_contact', pg_catalog.jsonb_build_object('booking_id', b.id));
    end if;
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
