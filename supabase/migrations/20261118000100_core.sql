-- =====================================================================
-- Kern: Mandanten und Mitgliedschaften
-- Grundsatz: Jede fachliche Tabelle hat tenant_id; Isolation über RLS
-- (siehe ..._rls.sql). Mandanten unterscheiden sich NUR über Daten.
-- =====================================================================

-- Interne Hilfsfunktionen leben in einem eigenen Schema, das Supabase
-- nicht über die REST-API veröffentlicht.
create schema if not exists app;
grant usage on schema app to anon, authenticated, service_role;

create type public.anrede as enum ('sie', 'ihr');
create type public.member_role as enum ('owner', 'admin', 'sales');

create or replace function app.set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create table public.tenants (
  id                    uuid primary key default gen_random_uuid(),
  slug                  text not null unique
                        check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  name                  text not null check (length(trim(name)) between 1 and 200),
  -- Optionale eigene Domain (z. B. termine.kunde.at), immer klein geschrieben
  custom_domain         text unique check (custom_domain = lower(custom_domain)),
  -- Theme-JSON; Schema + Defaults: lib/theme/schema.ts (ungültige Werte -> Default)
  theme                 jsonb not null default '{}'::jsonb check (jsonb_typeof(theme) = 'object'),
  anrede                public.anrede not null default 'sie',
  -- Überschreibungen einzelner Texte: { "<textKey>": "<Text>" }, siehe lib/texts
  text_overrides        jsonb not null default '{}'::jsonb check (jsonb_typeof(text_overrides) = 'object'),
  -- [{ "label": "Impressum", "href": "https://..." }, ...]
  legal_links           jsonb not null default '[]'::jsonb check (jsonb_typeof(legal_links) = 'array'),
  claim                 text,
  contact_line          text,
  -- Storage-Schlüssel des Logos (Bucket tenant-assets), null = Name als Text
  logo_path             text,
  sender_name           text,
  reply_to_email        text,
  -- Änderung/Stornierung durch den Kunden bis X Stunden vor Terminbeginn
  change_deadline_hours integer not null default 48 check (change_deadline_hours between 0 and 720),
  timezone              text not null default 'Europe/Vienna',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create trigger tenants_updated_at before update on public.tenants
  for each row execute function app.set_updated_at();

create table public.tenant_members (
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       public.member_role not null default 'sales',
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create index tenant_members_user_idx on public.tenant_members (user_id);

-- Ist der aktuelle Benutzer (auth.uid()) Mitglied des Mandanten, optional
-- mit einer der angegebenen Rollen? SECURITY DEFINER, damit die Policies auf
-- tenant_members nicht rekursiv sich selbst auswerten.
create or replace function app.is_member(p_tenant_id uuid, p_roles public.member_role[] default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_members m
    where m.tenant_id = p_tenant_id
      and m.user_id = auth.uid()
      and (p_roles is null or m.role = any (p_roles))
  )
$$;

revoke all on function app.is_member(uuid, public.member_role[]) from public;
grant execute on function app.is_member(uuid, public.member_role[]) to authenticated, service_role;
