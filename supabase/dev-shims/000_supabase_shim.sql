-- =====================================================================
-- NUR FÜR DIE LOKALE ÜBERGANGSUMGEBUNG (vorinstalliertes Postgres 16)
-- Wird NIE gegen Supabase ausgeführt. Bildet den Teil von Supabase nach,
-- auf den sich unsere regulären Migrationen verlassen:
--   * Rollen anon / authenticated / service_role
--   * Schema auth mit auth.users, auth.uid(), auth.role(), auth.jwt()
--   * Supabase-Standardrechte im Schema public
-- Alles idempotent, damit db:reset beliebig oft laufen kann.
-- =====================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

-- Die Verbindungsrolle (lokal: postgres) muss in diese Rollen wechseln dürfen,
-- wie der Supabase-"authenticator".
grant anon, authenticated, service_role to current_user;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- Entspricht den Supabase-Implementierungen (liest die JWT-Claims, die
-- PostgREST bzw. unser Datenzugriff pro Transaktion setzt).
create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

grant execute on all functions in schema auth to anon, authenticated, service_role;

-- Supabase vergibt im Schema public standardmäßig ALLE Rechte an
-- anon/authenticated/service_role; RLS ist dort die eigentliche Schranke.
-- Wir bilden das nach, damit unsere Tests dieselbe Ausgangslage prüfen.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
