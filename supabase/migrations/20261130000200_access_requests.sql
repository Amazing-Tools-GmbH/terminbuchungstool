-- =====================================================================
-- Zugriffsanfragen: Ein Pipedrive-Benutzer ohne Freischaltung (App
-- installiert/angemeldet, Panel oder App-Einstellungen geöffnet) wird nicht
-- nur abgewiesen – es entsteht eine Anfrage, und alle aktiven Owner/Admins
-- bekommen eine Mail (Outbox). Beim Freischalten bekommt der Benutzer eine
-- kurze Mail. Gesperrte Benutzer erzeugen keine Anfrage.
-- =====================================================================

alter type public.email_type add value if not exists 'access_request';
alter type public.email_type add value if not exists 'access_granted';

create table public.access_requests (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete cascade,
  pipedrive_user_id bigint not null,
  name              text check (name is null or length(name) <= 200),
  email             text check (email is null or (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 320)),
  status            text not null default 'open' check (status in ('open', 'approved', 'declined')),
  created_at        timestamptz not null default now(),
  decided_at        timestamptz,
  decided_by        uuid references auth.users (id) on delete set null
);

create unique index access_requests_one_open on public.access_requests (tenant_id, pipedrive_user_id) where status = 'open';
create index access_requests_tenant_idx on public.access_requests (tenant_id, created_at desc);

alter table public.access_requests enable row level security;
revoke all on table public.access_requests from anon, authenticated;
grant select on public.access_requests to authenticated;
grant all on public.access_requests to service_role;

create policy access_requests_select on public.access_requests
  for select to authenticated
  using (app.is_member(tenant_id, array['owner', 'admin']::public.member_role[]));

-- ---------------------------------------------------------------------
-- Anfrage festhalten (Server, service_role). Neue Anfrage -> Mail an alle
-- aktiven Owner/Admins. Ergebnis: true = neu angelegt.
-- ---------------------------------------------------------------------
create or replace function public.record_access_request(
  p_tenant_id uuid, p_pipedrive_user_id bigint, p_name text, p_email text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    uuid;
  v_name  text := nullif(left(btrim(coalesce(p_name, '')), 200), '');
  v_email text := lower(nullif(btrim(coalesce(p_email, '')), ''));
  m       record;
begin
  if v_email is not null and v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    v_email := null;
  end if;
  -- schon Mitglied (auch gesperrt): keine Anfrage
  if exists (select 1 from public.tenant_members where tenant_id = p_tenant_id and pipedrive_user_id = p_pipedrive_user_id) then
    return false;
  end if;
  -- offene Anfrage: nur Angaben ergänzen, keine weitere Mail
  update public.access_requests
     set name = coalesce(v_name, name), email = coalesce(v_email, email)
   where tenant_id = p_tenant_id and pipedrive_user_id = p_pipedrive_user_id and status = 'open';
  if found then
    return false;
  end if;

  insert into public.access_requests (tenant_id, pipedrive_user_id, name, email)
  values (p_tenant_id, p_pipedrive_user_id, v_name, v_email)
  returning id into v_id;

  for m in
    select coalesce(tm.email, u.email) as email
      from public.tenant_members tm join auth.users u on u.id = tm.user_id
     where tm.tenant_id = p_tenant_id and tm.status = 'active' and tm.role in ('owner', 'admin')
       and coalesce(tm.email, u.email) is not null
  loop
    insert into public.email_outbox (tenant_id, type, to_email, payload)
    values (p_tenant_id, 'access_request', lower(m.email), jsonb_build_object('request_id', v_id));
  end loop;
  return true;
end
$$;

-- ---------------------------------------------------------------------
-- Anfrage abschließen (owner/admin). Freigeschaltet -> kurze Mail an den
-- Benutzer (falls E-Mail bekannt). Ohne offene Anfrage: nichts.
-- ---------------------------------------------------------------------
create or replace function public.close_access_request(p_tenant_id uuid, p_pipedrive_user_id bigint, p_approved boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.access_requests;
begin
  perform app.require_manager(p_tenant_id);
  update public.access_requests
     set status = case when p_approved then 'approved' else 'declined' end, decided_at = now(), decided_by = auth.uid()
   where tenant_id = p_tenant_id and pipedrive_user_id = p_pipedrive_user_id and status = 'open'
  returning * into r;
  if not found then
    return false;
  end if;
  if p_approved and r.email is not null then
    insert into public.email_outbox (tenant_id, type, to_email, payload)
    values (p_tenant_id, 'access_granted', r.email, jsonb_build_object('request_id', r.id));
  end if;
  return true;
end
$$;

revoke all on function public.record_access_request(uuid, bigint, text, text) from public, anon, authenticated;
revoke all on function public.close_access_request(uuid, bigint, boolean) from public, anon, authenticated;
grant execute on function public.record_access_request(uuid, bigint, text, text) to service_role;
grant execute on function public.close_access_request(uuid, bigint, boolean) to authenticated, service_role;
