-- =====================================================================
-- Zentrale Adressen ohne Kunden-Subdomain (alles unter APP_BASE_URL, z. B.
-- https://atools.de/meetings):
--   * Buchungsseite /b/<token>: der Mandant ergibt sich aus dem Buchungslink
--   * Admin-Backend: der Mandant ergibt sich aus der Sitzung (Pipedrive-Login
--     bzw. Einstieg aus den Pipedrive-App-Einstellungen über companyId)
-- Eigene Kundendomains (tenants.custom_domain) bleiben optional möglich.
-- =====================================================================

-- Öffentliche Mandantendaten zu einem Buchungslink (gleiche Felder wie
-- resolve_tenant). Token-gebunden wie alle anon-Funktionen; null = unbekannt.
create or replace function public.resolve_tenant_by_token(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.resolve_tenant(t.slug, null)
  from public.invitations i
  join public.tenants t on t.id = i.tenant_id
  where p_token is not null
    and length(p_token) between 20 and 200
    and i.token_hash = app.hash_token(p_token)
$$;

revoke all on function public.resolve_tenant_by_token(text) from public, anon, authenticated;
grant execute on function public.resolve_tenant_by_token(text) to anon, authenticated, service_role;

-- Öffentliche Mandantendaten zur ID (Sitzung im zentralen Admin-Backend).
-- Nur für Mitglieder des Mandanten.
create or replace function public.resolve_tenant_by_id(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.resolve_tenant(t.slug, null)
  from public.tenants t
  where t.id = p_tenant_id
    and app.is_member(t.id)
$$;

revoke all on function public.resolve_tenant_by_id(uuid) from public, anon, authenticated;
grant execute on function public.resolve_tenant_by_id(uuid) to authenticated, service_role;
