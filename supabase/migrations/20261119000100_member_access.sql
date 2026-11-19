-- =====================================================================
-- Phase 3: Benutzerzugriff über Pipedrive + Admin-Backend
--
-- Benutzer melden sich über Pipedrive an. Wer Zugriff hat, steuert der
-- Mandant selbst in der Nutzerverwaltung: Pipedrive-Benutzer werden
-- freigeschaltet (status = active) oder gesperrt (disabled) und bekommen
-- eine Rolle. Neue Pipedrive-Benutzer haben standardmäßig keinen Zugriff.
-- Wer die Pipedrive-App installiert, wird owner (Phase 4).
--
-- Identität: tenant_members.user_id -> auth.users (E-Mail). Beim Login
-- prüft der Server zusätzlich, dass die E-Mail aus Pipedrive (/users/me)
-- mit der E-Mail des auth-Benutzers übereinstimmt.
-- =====================================================================

create type public.member_status as enum ('active', 'disabled');

alter table public.tenant_members
  add column pipedrive_user_id bigint,
  add column status            public.member_status not null default 'active',
  -- Anzeigename/E-Mail aus Pipedrive (Cache für die Oberfläche)
  add column display_name      text check (display_name is null or length(display_name) <= 200),
  add column email             text check (email is null or email = lower(email)),
  add column updated_at        timestamptz not null default now();

create unique index tenant_members_pipedrive_user_idx
  on public.tenant_members (tenant_id, pipedrive_user_id)
  where pipedrive_user_id is not null;

create trigger tenant_members_updated_at before update on public.tenant_members
  for each row execute function app.set_updated_at();

-- Gesperrte Mitglieder verlieren sofort jeden Zugriff: is_member zählt nur
-- aktive Mitgliedschaften (alle Policies bauen darauf auf).
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
      and m.status = 'active'
      and (p_roles is null or m.role = any (p_roles))
  )
$$;

-- ---------------------------------------------------------------------
-- tenant_members: owner verwaltet alle; admin verwaltet alle außer owner
-- (kann niemanden zum owner machen und keinen owner ändern/entfernen).
-- Spaltenrechte: tenant_id/user_id/pipedrive_user_id sind nach dem
-- Anlegen nicht mehr änderbar.
-- ---------------------------------------------------------------------
drop policy tenant_members_write on public.tenant_members;

revoke insert, update, delete on public.tenant_members from authenticated;
grant insert (tenant_id, user_id, role, status, pipedrive_user_id, display_name, email)
  on public.tenant_members to authenticated;
grant update (role, status, display_name, email) on public.tenant_members to authenticated;
grant delete on public.tenant_members to authenticated;

create policy tenant_members_insert on public.tenant_members
  for insert to authenticated
  with check (
    app.is_member(tenant_id, array['owner']::public.member_role[])
    or (app.is_member(tenant_id, array['admin']::public.member_role[]) and role <> 'owner')
  );

create policy tenant_members_update on public.tenant_members
  for update to authenticated
  using (
    app.is_member(tenant_id, array['owner']::public.member_role[])
    or (app.is_member(tenant_id, array['admin']::public.member_role[]) and role <> 'owner')
  )
  with check (
    app.is_member(tenant_id, array['owner']::public.member_role[])
    or (app.is_member(tenant_id, array['admin']::public.member_role[]) and role <> 'owner')
  );

create policy tenant_members_delete on public.tenant_members
  for delete to authenticated
  using (
    app.is_member(tenant_id, array['owner']::public.member_role[])
    or (app.is_member(tenant_id, array['admin']::public.member_role[]) and role <> 'owner')
  );

-- ---------------------------------------------------------------------
-- Jeder Mandant behält mindestens einen aktiven owner. Sperrt die
-- Mandantenzeile, damit zwei gleichzeitige Änderungen nicht beide den
-- jeweils anderen owner als "noch vorhanden" sehen. Beim Löschen des
-- ganzen Mandanten (Kaskade) greift die Prüfung nicht.
-- ---------------------------------------------------------------------
create or replace function app.ensure_tenant_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.tenants t where t.id = old.tenant_id for update;
  if not found then
    return null;
  end if;
  if not exists (
    select 1 from public.tenant_members m
    where m.tenant_id = old.tenant_id and m.role = 'owner' and m.status = 'active'
  ) then
    raise exception using errcode = 'P0001', message = 'TB:last_owner';
  end if;
  return null;
end
$$;

revoke all on function app.ensure_tenant_owner() from public, anon, authenticated;

create trigger tenant_members_keep_owner
  after update or delete on public.tenant_members
  for each row
  when (old.role = 'owner' and old.status = 'active')
  execute function app.ensure_tenant_owner();

-- ---------------------------------------------------------------------
-- Kapazität eines Termins nie unter die bereits gebuchten Plätze.
-- Das UPDATE hält die Zeilensperre auf dem Slot; book_slot sperrt den
-- Slot ebenfalls (FOR UPDATE) -> beide laufen nacheinander.
-- ---------------------------------------------------------------------
create or replace function app.check_slot_capacity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booked integer;
begin
  if new.capacity is distinct from old.capacity then
    v_booked := app.slot_booked_seats(new.id);
    if new.capacity < v_booked then
      raise exception using errcode = 'P0001', message = 'TB:capacity_below_booked',
        detail = pg_catalog.json_build_object('booked', v_booked)::text;
    end if;
  end if;
  return new;
end
$$;

revoke all on function app.check_slot_capacity() from public, anon, authenticated;

create trigger slots_check_capacity before update of capacity on public.slots
  for each row execute function app.check_slot_capacity();

-- ---------------------------------------------------------------------
-- Pipedrive-Domain für Deal-Links im Admin (pipedrive_connections selbst
-- ist für authenticated nicht lesbar, weil sie Tokens enthält).
-- ---------------------------------------------------------------------
create or replace function public.get_pipedrive_company_domain(p_tenant_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select c.company_domain
  from public.pipedrive_connections c
  where c.tenant_id = p_tenant_id
    and app.is_member(p_tenant_id)
$$;

revoke all on function public.get_pipedrive_company_domain(uuid) from public, anon, authenticated;
grant execute on function public.get_pipedrive_company_domain(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Nur für den Server (service_role): auth-Benutzer per E-Mail finden und
-- Login-Daten eines Pipedrive-Benutzers nachschlagen.
-- ---------------------------------------------------------------------
create or replace function public.auth_user_id_by_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id from auth.users u where lower(u.email) = lower(p_email) limit 1
$$;

revoke all on function public.auth_user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.auth_user_id_by_email(text) to service_role;

create or replace function public.member_login_lookup(p_tenant_id uuid, p_pipedrive_user_id bigint)
returns table (user_id uuid, auth_email text, role public.member_role, status public.member_status)
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id, lower(u.email), m.role, m.status
  from public.tenant_members m
  join auth.users u on u.id = m.user_id
  where m.tenant_id = p_tenant_id
    and m.pipedrive_user_id = p_pipedrive_user_id
$$;

revoke all on function public.member_login_lookup(uuid, bigint) from public, anon, authenticated;
grant execute on function public.member_login_lookup(uuid, bigint) to service_role;
