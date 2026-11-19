-- =====================================================================
-- Einladungen (persönliche Buchungslinks) und Buchungen
-- Buchungslink = zufälliges Token; gespeichert wird nur sha256(token).
-- Buchungen entstehen AUSSCHLIESSLICH über public.book_slot().
-- =====================================================================

create type public.invitation_status as enum ('open', 'booked', 'cancelled', 'revoked');
create type public.booking_status    as enum ('confirmed', 'cancelled');

create table public.invitations (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  event_id            uuid not null,
  token_hash          bytea not null unique check (length(token_hash) = 32),
  name                text not null check (length(trim(name)) between 1 and 200),
  email               text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  -- Firma des Eingeladenen (aus Pipedrive), Anzeige im Header der Buchungsseite
  organization_name   text,
  pipedrive_deal_id   bigint,
  pipedrive_person_id bigint,
  -- null = alle Termine der Veranstaltung buchbar
  allowed_slot_ids    uuid[],
  status              public.invitation_status not null default 'open',
  expires_at          timestamptz not null,
  sent_at             timestamptz,
  created_by          uuid references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id) references public.tenants (id) on delete cascade,
  foreign key (tenant_id, event_id) references public.events (tenant_id, id) on delete cascade
);

create index invitations_event_idx on public.invitations (tenant_id, event_id);
create index invitations_deal_idx  on public.invitations (tenant_id, pipedrive_deal_id)
  where pipedrive_deal_id is not null;
create trigger invitations_updated_at before update on public.invitations
  for each row execute function app.set_updated_at();

create table public.bookings (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  slot_id         uuid not null,
  invitation_id   uuid not null,
  name            text not null check (length(trim(name)) between 1 and 200),
  email           text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  seats           integer not null check (seats between 1 and 1000),
  extra_attendees text[] not null default '{}',
  status          public.booking_status not null default 'confirmed',
  -- Bei Umbuchung: Verweis auf die Buchung, die diese ersetzt hat
  replaced_by     uuid references public.bookings (id) on delete set null,
  created_at      timestamptz not null default now(),
  cancelled_at    timestamptz,
  unique (tenant_id, id),
  check (cardinality(extra_attendees) <= seats - 1),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  foreign key (tenant_id) references public.tenants (id) on delete cascade,
  -- NO ACTION (nicht RESTRICT): Einzelne Slots/Einladungen mit Buchungen
  -- lassen sich nicht löschen, das Löschen eines ganzen Mandanten aber schon.
  foreign key (tenant_id, slot_id)       references public.slots (tenant_id, id),
  foreign key (tenant_id, invitation_id) references public.invitations (tenant_id, id)
);

-- Höchstens eine aktive Buchung pro Einladung ("Buchung ändern" ersetzt sie)
create unique index bookings_one_active_per_invitation
  on public.bookings (invitation_id) where status = 'confirmed';
create index bookings_slot_confirmed_idx
  on public.bookings (slot_id) where status = 'confirmed';
create index bookings_tenant_idx on public.bookings (tenant_id, created_at desc);
