-- =====================================================================
-- Öffentliche, token-gebundene Funktionen der Buchungsseite
-- * Aufrufbar von anon (Buchungsseite), authenticated, service_role.
-- * SECURITY DEFINER: Sie umgehen RLS gezielt, verlangen dafür aber IMMER
--   den Mandanten (aus der Host-Auflösung) UND das Klartext-Token. Ohne
--   gültiges Token gibt es keine Daten.
-- * Fehler: raise exception mit message = 'TB:<code>' (errcode P0001);
--   die App übersetzt die Codes (lib/booking/errors.ts).
-- * Mails: Die Outbox braucht für Links in Mails den Buchungslink. In der
--   DB steht das Token aber nur als Hash. Die App übergibt deshalb den Link
--   mit ENCRYPTION_KEY verschlüsselt (p_link_enc); er landet nur so im
--   Outbox-Payload und wird erst beim Versand entschlüsselt.
-- * Sperrreihenfolge (gegen Deadlocks, auch für spätere Funktionen):
--   erst invitations-Zeile, dann slots-Zeile.
-- =====================================================================

create or replace function app.hash_token(p_token text) returns bytea
language sql immutable strict
set search_path = ''
as $$
  select pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8'))
$$;

-- Bestätigte Plätze eines Slots
create or replace function app.slot_booked_seats(p_slot_id uuid, p_exclude_booking_id uuid default null)
returns integer
language sql stable
set search_path = ''
as $$
  select coalesce(sum(b.seats), 0)::integer
  from public.bookings b
  where b.slot_id = p_slot_id
    and b.status = 'confirmed'
    and (p_exclude_booking_id is null or b.id <> p_exclude_booking_id)
$$;

-- ---------------------------------------------------------------------
-- Öffentliche Mandantendaten für Buchungsseite/Branding.
-- Auflösung über Slug ODER eigene Domain (aus der Middleware).
-- Gibt nur unkritische Felder zurück.
-- ---------------------------------------------------------------------
create or replace function public.resolve_tenant(p_slug text default null, p_domain text default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', t.id,
    'slug', t.slug,
    'custom_domain', t.custom_domain,
    'name', t.name,
    'theme', t.theme,
    'anrede', t.anrede,
    'text_overrides', t.text_overrides,
    'legal_links', t.legal_links,
    'claim', t.claim,
    'contact_line', t.contact_line,
    'logo_path', t.logo_path,
    'change_deadline_hours', t.change_deadline_hours,
    'timezone', t.timezone
  )
  from public.tenants t
  where (p_slug is not null and t.slug = lower(p_slug))
     or (p_domain is not null and t.custom_domain = lower(p_domain))
  order by (t.slug = lower(coalesce(p_slug, ''))) desc
  limit 1
$$;

-- ---------------------------------------------------------------------
-- Alles, was die Buchungsseite zu einem Buchungslink braucht.
-- null = Link unbekannt, gehört zu anderem Mandanten oder wurde widerrufen.
-- ---------------------------------------------------------------------
create or replace function public.get_invitation_context(p_tenant_id uuid, p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_inv     public.invitations;
  v_event   public.events;
  v_tenant  public.tenants;
  v_booking public.bookings;
  v_bslot   public.slots;
  v_slots   jsonb;
begin
  if p_tenant_id is null or p_token is null or length(p_token) not between 20 and 200 then
    return null;
  end if;

  select * into v_inv
  from public.invitations i
  where i.token_hash = app.hash_token(p_token)
    and i.tenant_id = p_tenant_id;
  if not found or v_inv.status = 'revoked' then
    return null;
  end if;

  select * into v_tenant from public.tenants where id = v_inv.tenant_id;
  select * into v_event  from public.events  where id = v_inv.event_id;

  select * into v_booking
  from public.bookings b
  where b.invitation_id = v_inv.id and b.status = 'confirmed';
  if found then
    select * into v_bslot from public.slots where id = v_booking.slot_id;
  end if;

  select coalesce(jsonb_agg(x.j order by x.starts_at), '[]'::jsonb) into v_slots
  from (
    select
      s.starts_at,
      jsonb_build_object(
        'id', s.id,
        'starts_at', s.starts_at,
        'ends_at', s.ends_at,
        'capacity', s.capacity,
        'booked', bk.booked,
        'free', greatest(s.capacity - bk.booked, 0),
        -- eigene Plätze in diesem Slot (für "Buchung ändern" auf demselben Termin)
        'own_seats', case when v_booking.slot_id = s.id then v_booking.seats else 0 end,
        'location', coalesce(s.location, v_event.location),
        'status', s.status,
        'bookable', s.status = 'open' and s.starts_at > now()
                    and greatest(s.capacity - bk.booked, 0)
                        + case when v_booking.slot_id = s.id then v_booking.seats else 0 end > 0
      ) as j
    from public.slots s
    cross join lateral (select app.slot_booked_seats(s.id) as booked) bk
    where s.event_id = v_inv.event_id
      and s.status <> 'cancelled'
      and s.ends_at > now()
      and (v_inv.allowed_slot_ids is null or s.id = any (v_inv.allowed_slot_ids))
  ) x;

  return jsonb_build_object(
    'invitation', jsonb_build_object(
      'id', v_inv.id,
      'name', v_inv.name,
      'email', v_inv.email,
      'organization_name', v_inv.organization_name,
      'status', v_inv.status,
      'expires_at', v_inv.expires_at,
      'expired', v_inv.expires_at <= now()
    ),
    'event', jsonb_build_object(
      'id', v_event.id,
      'title', v_event.title,
      'description', v_event.description,
      'intro_text', v_event.intro_text,
      'location', v_event.location,
      'status', v_event.status
    ),
    'slots', v_slots,
    'booking', case when v_booking.id is null then null else jsonb_build_object(
      'id', v_booking.id,
      'slot_id', v_booking.slot_id,
      'starts_at', v_bslot.starts_at,
      'ends_at', v_bslot.ends_at,
      'location', coalesce(v_bslot.location, v_event.location),
      'seats', v_booking.seats,
      'name', v_booking.name,
      'email', v_booking.email,
      'extra_attendees', to_jsonb(v_booking.extra_attendees),
      'created_at', v_booking.created_at,
      'change_until', v_bslot.starts_at - make_interval(hours => v_tenant.change_deadline_hours),
      'changeable', now() < v_bslot.starts_at - make_interval(hours => v_tenant.change_deadline_hours)
    ) end
  );
end
$$;

-- ---------------------------------------------------------------------
-- Buchen bzw. Umbuchen – der EINZIGE Weg, eine Buchung anzulegen.
-- Überbuchungsschutz: Slot-Zeile wird mit FOR UPDATE gesperrt, freie
-- Plätze werden unter der Sperre gezählt, Buchung in derselben Transaktion
-- geschrieben. Parallele Buchungen auf denselben Slot laufen so seriell.
-- ---------------------------------------------------------------------
create or replace function public.book_slot(
  p_tenant_id       uuid,
  p_token           text,
  p_slot_id         uuid,
  p_seats           integer,
  p_name            text,
  p_email           text,
  p_extra_attendees text[] default '{}',
  p_link_enc        text default null
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
  v_free     integer;
  v_new_id   uuid := gen_random_uuid();
  v_name     text := trim(coalesce(p_name, ''));
  v_email    text := lower(trim(coalesce(p_email, '')));
  v_extra    text[];
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
  end if;

  insert into public.bookings (id, tenant_id, slot_id, invitation_id, name, email, seats, extra_attendees)
  values (v_new_id, v_inv.tenant_id, v_slot.id, v_inv.id, v_name, v_email, p_seats, v_extra);

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

  return jsonb_build_object(
    'booking_id', v_new_id,
    'slot_id', v_slot.id,
    'seats', p_seats,
    'replaced_booking_id', v_old.id
  );
end
$$;

-- ---------------------------------------------------------------------
-- Stornieren durch den Kunden (über seinen Buchungslink, mit Frist)
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

  return jsonb_build_object('booking_id', v_booking.id);
end
$$;

-- ---------------------------------------------------------------------
-- Rechte: Supabase vergibt EXECUTE standardmäßig an alle -> explizit setzen
-- ---------------------------------------------------------------------
revoke all on function app.hash_token(text)                   from public, anon, authenticated;
revoke all on function app.slot_booked_seats(uuid, uuid)      from public, anon, authenticated;
revoke all on function app.set_updated_at()                   from public, anon, authenticated;
grant execute on function app.hash_token(text)                to service_role;
grant execute on function app.slot_booked_seats(uuid, uuid)   to authenticated, service_role;

revoke all on function public.resolve_tenant(text, text)                                   from public;
revoke all on function public.get_invitation_context(uuid, text)                           from public;
revoke all on function public.book_slot(uuid, text, uuid, integer, text, text, text[], text)     from public;
revoke all on function public.cancel_booking(uuid, text, text)                                   from public;
grant execute on function public.resolve_tenant(text, text)                               to anon, authenticated, service_role;
grant execute on function public.get_invitation_context(uuid, text)                       to anon, authenticated, service_role;
grant execute on function public.book_slot(uuid, text, uuid, integer, text, text, text[], text) to anon, authenticated, service_role;
grant execute on function public.cancel_booking(uuid, text, text)                               to anon, authenticated, service_role;
