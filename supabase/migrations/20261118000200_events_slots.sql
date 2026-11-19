-- =====================================================================
-- Veranstaltungen und Termine (Slots)
-- Fremdschlüssel sind zusammengesetzt (tenant_id, id): Ein Slot kann so
-- technisch nie auf die Veranstaltung eines anderen Mandanten zeigen.
-- =====================================================================

create type public.event_status as enum ('draft', 'published', 'archived');
create type public.slot_status  as enum ('open', 'closed', 'cancelled');

create table public.events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  title       text not null check (length(trim(title)) between 1 and 200),
  description text,
  -- Einleitung im Hero der Buchungsseite; null = Standardtext je Anrede
  intro_text  text,
  location    text,
  status      public.event_status not null default 'draft',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id)
);

create index events_tenant_idx on public.events (tenant_id, status);
create trigger events_updated_at before update on public.events
  for each row execute function app.set_updated_at();

create table public.slots (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  event_id   uuid not null,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  capacity   integer not null check (capacity between 0 and 10000),
  -- Abweichender Ort für diesen Termin; null = Ort der Veranstaltung
  location   text,
  status     public.slot_status not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (ends_at > starts_at),
  foreign key (tenant_id) references public.tenants (id) on delete cascade,
  foreign key (tenant_id, event_id) references public.events (tenant_id, id) on delete cascade
);

create index slots_event_idx on public.slots (tenant_id, event_id, starts_at);
create trigger slots_updated_at before update on public.slots
  for each row execute function app.set_updated_at();
