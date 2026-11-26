-- =====================================================================
-- Rolle von Hand gesetzt: Pipedrive-Admins werden automatisch Admin
-- (lib/pipedrive/admin-sync.ts). Hat ein Owner/Admin die Rolle eines
-- Mitglieds selbst festgelegt (Freischalten mit Rolle oder Rolle ändern),
-- bleibt diese Entscheidung bestehen – auch "Vertrieb" für einen
-- Pipedrive-Admin. Gesetzt per Trigger, sobald ein angemeldeter Benutzer
-- (auth.uid()) die Rolle setzt; Server-Jobs (service_role) setzen es nicht.
-- =====================================================================

alter table public.tenant_members
  add column role_manual boolean not null default false;

create or replace function app.mark_role_manual()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is not null
     and (tg_op = 'INSERT' or new.role is distinct from old.role) then
    new.role_manual := true;
  end if;
  return new;
end
$$;

revoke all on function app.mark_role_manual() from public, anon, authenticated;

create trigger tenant_members_role_manual
  before insert or update of role on public.tenant_members
  for each row execute function app.mark_role_manual();
