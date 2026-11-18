-- =====================================================================
-- Row Level Security
-- * authenticated: sieht/ändert nur Daten der Mandanten, in denen er
--   Mitglied ist (app.is_member). Schreibrechte je Rolle.
-- * anon: KEIN direkter Tabellenzugriff. Die öffentliche Buchungsseite
--   arbeitet ausschließlich über token-gebundene Funktionen (..._booking_functions.sql).
-- * service_role (Server-Jobs, Pipedrive-Installation, Seed): BYPASSRLS.
-- Supabase vergibt standardmäßig alle Tabellenrechte an anon/authenticated;
-- wir entziehen sie hier ausdrücklich und vergeben nur das Nötige.
-- =====================================================================

do $$
declare
  t text;
begin
  foreach t in array array[
    'tenants', 'tenant_members', 'events', 'slots', 'invitations', 'bookings',
    'pipedrive_connections', 'mail_connections', 'email_outbox'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------
-- tenants: Mitglieder lesen; owner/admin ändern Einstellungen.
-- Anlegen/Löschen nur serverseitig (Pipedrive-Installation, service_role).
-- ---------------------------------------------------------------------
grant select, update on public.tenants to authenticated;

create policy tenants_select on public.tenants
  for select to authenticated
  using (app.is_member(id));

create policy tenants_update on public.tenants
  for update to authenticated
  using (app.is_member(id, array['owner', 'admin']::public.member_role[]))
  with check (app.is_member(id, array['owner', 'admin']::public.member_role[]));

-- ---------------------------------------------------------------------
-- tenant_members: Mitglieder sehen ihr Team; nur owner verwaltet es
-- (verhindert, dass sich ein admin selbst zum owner macht).
-- ---------------------------------------------------------------------
grant select, insert, update, delete on public.tenant_members to authenticated;

create policy tenant_members_select on public.tenant_members
  for select to authenticated
  using (app.is_member(tenant_id));

create policy tenant_members_write on public.tenant_members
  for all to authenticated
  using (app.is_member(tenant_id, array['owner']::public.member_role[]))
  with check (app.is_member(tenant_id, array['owner']::public.member_role[]));

-- ---------------------------------------------------------------------
-- events / slots: Mitglieder lesen; owner/admin pflegen.
-- ---------------------------------------------------------------------
grant select, insert, update, delete on public.events to authenticated;
grant select, insert, update, delete on public.slots  to authenticated;

create policy events_select on public.events
  for select to authenticated
  using (app.is_member(tenant_id));

create policy events_write on public.events
  for all to authenticated
  using (app.is_member(tenant_id, array['owner', 'admin']::public.member_role[]))
  with check (app.is_member(tenant_id, array['owner', 'admin']::public.member_role[]));

create policy slots_select on public.slots
  for select to authenticated
  using (app.is_member(tenant_id));

create policy slots_write on public.slots
  for all to authenticated
  using (app.is_member(tenant_id, array['owner', 'admin']::public.member_role[]))
  with check (app.is_member(tenant_id, array['owner', 'admin']::public.member_role[]));

-- ---------------------------------------------------------------------
-- invitations: alle Mitglieder (auch sales) lesen und legen an;
-- löschen nur owner/admin. token_hash ist für niemanden lesbar außer
-- service_role (Spaltenrechte).
-- ---------------------------------------------------------------------
grant select (id, tenant_id, event_id, name, email, pipedrive_deal_id, pipedrive_person_id,
              allowed_slot_ids, status, expires_at, sent_at, created_by, created_at, updated_at)
  on public.invitations to authenticated;
grant insert, update, delete on public.invitations to authenticated;

create policy invitations_select on public.invitations
  for select to authenticated
  using (app.is_member(tenant_id));

create policy invitations_insert on public.invitations
  for insert to authenticated
  with check (app.is_member(tenant_id));

create policy invitations_update on public.invitations
  for update to authenticated
  using (app.is_member(tenant_id))
  with check (app.is_member(tenant_id));

create policy invitations_delete on public.invitations
  for delete to authenticated
  using (app.is_member(tenant_id, array['owner', 'admin']::public.member_role[]));

-- ---------------------------------------------------------------------
-- bookings: Mitglieder lesen; owner/admin dürfen ändern (z. B. stornieren).
-- KEIN insert: Buchungen nur über public.book_slot() (Überbuchungsschutz).
-- ---------------------------------------------------------------------
grant select, update on public.bookings to authenticated;

create policy bookings_select on public.bookings
  for select to authenticated
  using (app.is_member(tenant_id));

create policy bookings_update on public.bookings
  for update to authenticated
  using (app.is_member(tenant_id, array['owner', 'admin']::public.member_role[]))
  with check (app.is_member(tenant_id, array['owner', 'admin']::public.member_role[]));

-- ---------------------------------------------------------------------
-- pipedrive_connections: enthält OAuth-Tokens -> nur service_role.
-- (RLS an, keine Policy, keine Rechte für anon/authenticated)
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- mail_connections: owner/admin sehen Status (ohne Zugangsdaten);
-- Verbinden/Ändern läuft serverseitig (Testmail, Verschlüsselung).
-- ---------------------------------------------------------------------
grant select (id, tenant_id, scope, user_id, provider, sender_email, sender_name,
              status, last_error, last_verified_at, created_at, updated_at)
  on public.mail_connections to authenticated;

create policy mail_connections_select on public.mail_connections
  for select to authenticated
  using (
    app.is_member(tenant_id, array['owner', 'admin']::public.member_role[])
    or (scope = 'user' and user_id = auth.uid() and app.is_member(tenant_id))
  );

-- ---------------------------------------------------------------------
-- email_outbox: owner/admin lesen (Versandstatus); geschrieben wird nur
-- von Datenbankfunktionen und Server-Jobs.
-- ---------------------------------------------------------------------
grant select on public.email_outbox to authenticated;

create policy email_outbox_select on public.email_outbox
  for select to authenticated
  using (app.is_member(tenant_id, array['owner', 'admin']::public.member_role[]));
