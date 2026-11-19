-- =====================================================================
-- E-Mail: Versand über das eigene Postfach des Mandanten
-- * mail_connections: verbundene Postfächer (Google, Microsoft, SMTP; dev lokal)
-- * email_outbox: jede Mail läuft über die Outbox (Retry per Cron). Eine
--   Buchung scheitert nie daran, dass eine Mail nicht rausgeht.
-- =====================================================================

create type public.mail_scope    as enum ('tenant', 'user');
create type public.mail_provider as enum ('google', 'microsoft', 'smtp', 'dev');
-- pending = angelegt, Testmail noch nicht erfolgreich
create type public.mail_status   as enum ('pending', 'active', 'error', 'revoked');
create type public.email_type    as enum ('invitation', 'confirmation', 'cancellation', 'test');
create type public.outbox_status as enum ('queued', 'sending', 'sent', 'failed');

create table public.mail_connections (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  scope            public.mail_scope not null default 'tenant',
  user_id          uuid references auth.users (id) on delete cascade,
  provider         public.mail_provider not null,
  sender_email     text not null check (sender_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  sender_name      text,
  -- verschlüsselt (lib/crypto); für authenticated NICHT lesbar (Spaltenrechte)
  credentials_enc  text,
  status           public.mail_status not null default 'pending',
  last_error       text,
  last_verified_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, id),
  check ((scope = 'user') = (user_id is not null))
);

-- Standard: ein Postfach je Mandant; später optional je Vertriebsmitarbeiter
create unique index mail_connections_one_per_tenant
  on public.mail_connections (tenant_id) where scope = 'tenant';
create unique index mail_connections_one_per_user
  on public.mail_connections (tenant_id, user_id) where scope = 'user';
create trigger mail_connections_updated_at before update on public.mail_connections
  for each row execute function app.set_updated_at();

create table public.email_outbox (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete cascade,
  type                public.email_type not null,
  to_email            text not null,
  -- Referenzen für das Rendern zum Versandzeitpunkt (z. B. { "booking_id": ... })
  payload             jsonb not null default '{}'::jsonb,
  status              public.outbox_status not null default 'queued',
  attempts            integer not null default 0,
  next_attempt_at     timestamptz not null default now(),
  locked_at           timestamptz,
  sent_at             timestamptz,
  provider_message_id text,
  last_error          text,
  -- Über welches Postfach versendet wurde bzw. werden soll (null = Mandanten-Postfach)
  mail_connection_id  uuid,
  -- Bei provider = dev: die gerenderte Mail, für /dev/mails
  rendered            jsonb,
  created_at          timestamptz not null default now(),
  foreign key (tenant_id, mail_connection_id) references public.mail_connections (tenant_id, id) on delete set null (mail_connection_id)
);

create index email_outbox_due_idx on public.email_outbox (next_attempt_at)
  where status in ('queued', 'sending');
create index email_outbox_tenant_idx on public.email_outbox (tenant_id, created_at desc);
