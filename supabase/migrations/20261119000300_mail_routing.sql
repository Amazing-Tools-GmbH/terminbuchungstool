-- =====================================================================
-- Mailversand nach Auftraggeber-Plan (19.11.2026):
--   * Einladungen: INVITE_MAIL_PROVIDER = pipedrive (Standard) | oauth | smtp
--       pipedrive: über das in Pipedrive verbundene Postfach des Mitarbeiters
--                  (OAuth-Token aus seinem Login, Scope mail-sending:full)
--       oauth:     über sein per Google/Microsoft verbundenes Postfach
--       smtp:      über die System-Adresse, Anzeigename = Mitarbeiter,
--                  Reply-To = Mitarbeiter, Smart BCC
--     Schlägt der gewählte Weg fehl, gibt es eine verständliche Meldung
--     (email_outbox.error_code) – nie einen stillen Wechsel des Weges.
--   * Bestätigung/Stornierung: immer System-SMTP, Reply-To = Mitarbeiter,
--     der eingeladen hat, Smart BCC.
-- =====================================================================

-- Pipedrive-OAuth-Zugang je Mitarbeiter (aus "Mit Pipedrive anmelden").
-- Tokens nur verschlüsselt und für authenticated nicht lesbar.
create table public.pipedrive_user_connections (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete cascade,
  user_id           uuid not null references auth.users (id) on delete cascade,
  pipedrive_user_id bigint not null,
  api_domain        text not null,
  access_token_enc  text not null,
  refresh_token_enc text not null,
  expires_at        timestamptz not null,
  -- vom Benutzer erteilte Scopes (u. a. mail-sending:full für den Versand)
  scopes            text,
  status            text not null default 'active' check (status in ('active', 'error')),
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create trigger pipedrive_user_connections_updated_at before update on public.pipedrive_user_connections
  for each row execute function app.set_updated_at();

alter table public.pipedrive_user_connections enable row level security;
revoke all on table public.pipedrive_user_connections from anon, authenticated;
grant select (id, tenant_id, user_id, pipedrive_user_id, scopes, status, last_error, created_at, updated_at)
  on public.pipedrive_user_connections to authenticated;

-- Eigener Zugang sichtbar; owner/admin sehen den Status aller (Team-Übersicht)
create policy pipedrive_user_connections_select on public.pipedrive_user_connections
  for select to authenticated
  using (
    (user_id = auth.uid() and app.is_member(tenant_id))
    or app.is_member(tenant_id, array['owner', 'admin']::public.member_role[])
  );

-- Signatur für Einladungen (Klartext; wird beim Rendern escaped)
alter table public.tenant_members
  add column mail_signature text check (mail_signature is null or length(mail_signature) <= 2000);

create or replace function public.set_my_mail_signature(p_tenant_id uuid, p_signature text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.tenant_members
     set mail_signature = nullif(btrim(p_signature), '')
   where tenant_id = p_tenant_id and user_id = auth.uid() and status = 'active';
  if not found then
    raise exception using errcode = 'P0001', message = 'TB:forbidden';
  end if;
end
$$;

revoke all on function public.set_my_mail_signature(uuid, text) from public, anon, authenticated;
grant execute on function public.set_my_mail_signature(uuid, text) to authenticated;

-- Outbox: über welchen Weg gesendet wurde und verständlicher Fehlercode
alter table public.email_outbox
  add column send_channel text check (send_channel is null or send_channel in ('pipedrive', 'oauth', 'smtp', 'system', 'connection')),
  add column error_code   text;
