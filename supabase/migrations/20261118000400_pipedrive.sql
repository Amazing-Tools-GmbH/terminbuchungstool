-- =====================================================================
-- Pipedrive-Verbindung (Phase 4, hier nur das Datenmodell)
-- EINE private Pipedrive-App für alle Kunden; die OAuth-Installation legt
-- den Mandanten an, Schlüssel ist die Pipedrive company_id.
-- Tokens werden in der App mit AES-256-GCM verschlüsselt (lib/crypto) und
-- hier nur als Chiffrat ("v1:<iv>:<tag>:<ciphertext>", base64) abgelegt.
-- =====================================================================

create table public.pipedrive_connections (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null unique references public.tenants (id) on delete cascade,
  company_id           bigint not null unique,
  api_domain           text not null,
  access_token_enc     text not null,
  refresh_token_enc    text not null,
  expires_at           timestamptz not null,
  scopes               text,
  installed_by_user_id bigint,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create trigger pipedrive_connections_updated_at before update on public.pipedrive_connections
  for each row execute function app.set_updated_at();
