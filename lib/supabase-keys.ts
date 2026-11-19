/**
 * Supabase-API-Schlüssel. Neues Format: publishable (sb_publishable_…) und
 * secret (sb_secret_…) – beide werden als `apikey`-Header (und Bearer)
 * akzeptiert. Die alten Namen (anon/service_role) gelten als Fallback.
 * Der secret key ist nur serverseitig zu verwenden.
 */
type Env = Record<string, string | undefined>;

export function supabaseSecretKey(env: Env = process.env): string | undefined {
  return env.SUPABASE_SECRET_KEY?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim() || undefined;
}

export function supabasePublishableKey(env: Env = process.env): string | undefined {
  return env.SUPABASE_PUBLISHABLE_KEY?.trim() || env.SUPABASE_ANON_KEY?.trim() || undefined;
}
