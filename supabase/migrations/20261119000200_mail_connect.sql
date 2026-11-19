-- =====================================================================
-- Postfach verbinden (Google / Microsoft / SMTP) je Benutzer und Firma,
-- Smart BCC (Ablage der Kundenmails in Pipedrive) und Absenderwahl.
--
-- Absender (Auswahl zum Versandzeitpunkt in lib/mail/sender-choice.ts):
--   * Einladung: Postfach des einladenden Mitarbeiters, sonst Firmenpostfach.
--     Ist sein Postfach gestört -> Mail wartet (kein Absenderwechsel).
--   * Bestätigung/Stornierung: Postfach dessen, der eingeladen hat, sonst
--     Firmenpostfach. Ist sein Postfach gestört -> Firmenpostfach, SICHTBAR
--     vermerkt (email_outbox.sender_fallback_reason, Admin-Backend).
-- =====================================================================

-- Smart-BCC-Adresse der Pipedrive-Firma (eine je Mandant). Nur Adressen von
-- Pipedrive, damit Kundenmails nicht an beliebige Adressen kopiert werden.
alter table public.tenants
  add column smart_bcc_email text
    check (smart_bcc_email is null
           or smart_bcc_email ~ '^[a-z0-9._+-]+@([a-z0-9-]+\.)*pipedrivemail\.com$');

alter table public.mail_connections
  -- OAuth-Scopes, die der Benutzer tatsächlich erteilt hat (Anzeige/Diagnose)
  add column granted_scopes text;

alter table public.email_outbox
  -- Warum nicht über das eigentlich vorgesehene Postfach gesendet wurde
  add column sender_fallback_reason text;

-- ---------------------------------------------------------------------
-- Zwischenspeicher zwischen OAuth-Callback (zentrale Adresse, ohne
-- Sitzung) und Abschluss auf der Mandanten-Adresse (mit Sitzung + Nonce).
-- Nur service_role; Einträge verfallen nach wenigen Minuten.
-- ---------------------------------------------------------------------
create table public.mail_oauth_pending (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  scope           public.mail_scope not null,
  provider        public.mail_provider not null check (provider in ('google', 'microsoft')),
  sender_email    text not null check (sender_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  sender_name     text,
  credentials_enc text not null,
  granted_scopes  text,
  nonce_hash      bytea not null check (length(nonce_hash) = 32),
  expires_at      timestamptz not null default now() + interval '10 minutes',
  created_at      timestamptz not null default now()
);

alter table public.mail_oauth_pending enable row level security;
revoke all on table public.mail_oauth_pending from anon, authenticated;
create index mail_oauth_pending_expires_idx on public.mail_oauth_pending (expires_at);

-- ---------------------------------------------------------------------
-- mail_connections: Benutzer trennen ihr eigenes Postfach; owner/admin
-- auch das Firmenpostfach und Postfächer anderer Mitglieder.
-- Anlegen/Ändern nur über public.save_mail_connection (Zugangsdaten).
-- ---------------------------------------------------------------------
grant delete on public.mail_connections to authenticated;

create policy mail_connections_delete on public.mail_connections
  for delete to authenticated
  using (
    app.is_member(tenant_id, array['owner', 'admin']::public.member_role[])
    or (scope = 'user' and user_id = auth.uid() and app.is_member(tenant_id))
  );

-- Postfach anlegen bzw. ersetzen (Status pending, bis die Testmail durch ist).
-- Zugangsdaten kommen bereits verschlüsselt vom Server.
create or replace function public.save_mail_connection(
  p_tenant_id       uuid,
  p_scope           public.mail_scope,
  p_provider        public.mail_provider,
  p_sender_email    text,
  p_sender_name     text,
  p_credentials_enc text,
  p_granted_scopes  text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null or not app.is_member(p_tenant_id) then
    raise exception using errcode = 'P0001', message = 'TB:forbidden';
  end if;
  if p_scope = 'tenant' and not app.is_member(p_tenant_id, array['owner', 'admin']::public.member_role[]) then
    raise exception using errcode = 'P0001', message = 'TB:forbidden';
  end if;
  if p_provider = 'dev' then
    raise exception using errcode = 'P0001', message = 'TB:forbidden';
  end if;

  if p_scope = 'tenant' then
    select id into v_id from public.mail_connections
     where tenant_id = p_tenant_id and scope = 'tenant' for update;
  else
    select id into v_id from public.mail_connections
     where tenant_id = p_tenant_id and scope = 'user' and user_id = v_uid for update;
  end if;

  if v_id is null then
    insert into public.mail_connections
      (tenant_id, scope, user_id, provider, sender_email, sender_name, credentials_enc, granted_scopes, status)
    values
      (p_tenant_id, p_scope, case when p_scope = 'user' then v_uid end, p_provider,
       lower(p_sender_email), p_sender_name, p_credentials_enc, p_granted_scopes, 'pending')
    returning id into v_id;
  else
    update public.mail_connections
       set provider = p_provider, sender_email = lower(p_sender_email), sender_name = p_sender_name,
           credentials_enc = p_credentials_enc, granted_scopes = p_granted_scopes,
           status = 'pending', last_error = null, last_verified_at = null
     where id = v_id;
  end if;
  return v_id;
end
$$;

revoke all on function public.save_mail_connection(uuid, public.mail_scope, public.mail_provider, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.save_mail_connection(uuid, public.mail_scope, public.mail_provider, text, text, text, text)
  to authenticated, service_role;

-- Testmail an das Postfach selbst in die Outbox legen (wer das Postfach sehen
-- darf, darf es testen). Liefert die Outbox-ID.
create or replace function public.request_mail_test(p_connection_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.mail_connections%rowtype;
  v_id   uuid;
begin
  select * into v_conn from public.mail_connections where id = p_connection_id;
  if not found or not (
    app.is_member(v_conn.tenant_id, array['owner', 'admin']::public.member_role[])
    or (v_conn.scope = 'user' and v_conn.user_id = auth.uid() and app.is_member(v_conn.tenant_id))
  ) then
    raise exception using errcode = 'P0001', message = 'TB:forbidden';
  end if;
  insert into public.email_outbox (tenant_id, type, to_email, mail_connection_id)
  values (v_conn.tenant_id, 'test', v_conn.sender_email, v_conn.id)
  returning id into v_id;
  return v_id;
end
$$;

revoke all on function public.request_mail_test(uuid) from public, anon, authenticated;
grant execute on function public.request_mail_test(uuid) to authenticated, service_role;

-- Firmenpostfach (Adresse + Status) für alle Mitglieder – z. B. damit
-- Vertriebsmitarbeiter sehen, worüber ihre Mails ohne eigenes Postfach gehen.
create or replace function public.get_tenant_mailbox(p_tenant_id uuid)
returns table (sender_email text, provider public.mail_provider, status public.mail_status)
language sql
stable
security definer
set search_path = ''
as $$
  select c.sender_email, c.provider, c.status
  from public.mail_connections c
  where c.tenant_id = p_tenant_id and c.scope = 'tenant' and app.is_member(p_tenant_id)
$$;

revoke all on function public.get_tenant_mailbox(uuid) from public, anon, authenticated;
grant execute on function public.get_tenant_mailbox(uuid) to authenticated, service_role;
