/**
 * Pipedrive: OAuth (Anmeldung, später Installation) und die wenigen
 * API-Aufrufe, die das Admin-Backend braucht. Reine Logik mit
 * austauschbarem fetch (Tests), ohne Datenbank.
 *
 * Doku: https://pipedrive.readme.io/docs/marketplace-oauth-authorization
 *       https://developers.pipedrive.com/docs/api/v1/Users
 */
import { z } from "zod";

export const PIPEDRIVE_OAUTH_BASE = "https://oauth.pipedrive.com";

type Fetch = typeof fetch;
type Env = Record<string, string | undefined>;

export type OAuthConfig = { clientId: string; clientSecret: string; redirectUri: string };

/** OAuth-Konfiguration aus der Umgebung; null, solange die App nicht eingerichtet ist. */
export function oauthConfig(env: Env = process.env): OAuthConfig | null {
  const clientId = env.PIPEDRIVE_CLIENT_ID?.trim();
  const clientSecret = env.PIPEDRIVE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  // EINE Callback-URL für alle Mandanten (so im Developer Hub eingetragen)
  const base = (env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return { clientId, clientSecret, redirectUri: `${base}/api/auth/pipedrive/callback` };
}

export function authorizeUrl(cfg: OAuthConfig, state: string): string {
  const u = new URL("/oauth/authorize", PIPEDRIVE_OAUTH_BASE);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("state", state);
  return u.toString();
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
  api_domain: z.string().url(),
});
export type PipedriveTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope: string | null;
  apiDomain: string;
};

export class PipedriveError extends Error {
  constructor(
    readonly kind: "oauth" | "api" | "unauthorized",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PipedriveError";
  }
}

async function tokenRequest(cfg: OAuthConfig, body: Record<string, string>, f: Fetch): Promise<PipedriveTokens> {
  const res = await f(`${PIPEDRIVE_OAUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new PipedriveError("oauth", `Token-Anfrage abgelehnt (${res.status})`, res.status);
  const parsed = tokenSchema.safeParse(await res.json());
  if (!parsed.success) throw new PipedriveError("oauth", "Unerwartete Token-Antwort");
  const t = parsed.data;
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    // etwas Puffer, damit ein Token nicht mitten in einer Anfrage abläuft
    expiresAt: new Date(Date.now() + (t.expires_in - 60) * 1000),
    scope: t.scope ?? null,
    apiDomain: t.api_domain.replace(/\/$/, ""),
  };
}

export function exchangeCode(cfg: OAuthConfig, code: string, f: Fetch = fetch): Promise<PipedriveTokens> {
  return tokenRequest(cfg, { grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri }, f);
}

export function refreshTokens(cfg: OAuthConfig, refreshToken: string, f: Fetch = fetch): Promise<PipedriveTokens> {
  return tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: refreshToken }, f);
}

// ---------------------------------------------------------------------
// API
// ---------------------------------------------------------------------

/** v1 liefert Flags je nach Endpunkt als boolean oder 0/1 */
const flag = z.union([z.boolean(), z.number()]).transform((v) => v === true || v === 1);

const userSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  email: z.string().email().transform((e) => e.toLowerCase()),
  is_admin: flag.optional().default(false),
  active_flag: flag.optional().default(true),
});

const meSchema = userSchema.extend({
  company_id: z.number().int().positive(),
  company_domain: z.string().min(1),
  company_name: z.string().optional(),
  timezone_name: z.string().optional(),
});

export type PipedriveUser = { id: number; name: string; email: string; isAdmin: boolean; active: boolean };
export type PipedriveMe = PipedriveUser & { companyId: number; companyDomain: string; companyName?: string; timezone?: string };

async function apiGet(apiDomain: string, accessToken: string, path: string, f: Fetch): Promise<unknown> {
  const res = await f(`${apiDomain.replace(/\/$/, "")}${path}`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (res.status === 401) throw new PipedriveError("unauthorized", "Pipedrive-Zugang ungültig oder entzogen", 401);
  if (!res.ok) throw new PipedriveError("api", `Pipedrive-API-Fehler (${res.status})`, res.status);
  const body = (await res.json()) as { success?: boolean; data?: unknown };
  if (body?.success === false) throw new PipedriveError("api", "Pipedrive-API meldet einen Fehler");
  return body?.data;
}

const toUser = (u: z.infer<typeof userSchema>): PipedriveUser => ({
  id: u.id,
  name: u.name,
  email: u.email,
  isAdmin: u.is_admin,
  active: u.active_flag,
});

export async function getMe(apiDomain: string, accessToken: string, f: Fetch = fetch): Promise<PipedriveMe> {
  const parsed = meSchema.safeParse(await apiGet(apiDomain, accessToken, "/api/v1/users/me", f));
  if (!parsed.success) throw new PipedriveError("api", "Unerwartete Antwort von /users/me");
  return {
    ...toUser(parsed.data),
    companyId: parsed.data.company_id,
    companyDomain: parsed.data.company_domain.toLowerCase(),
    companyName: parsed.data.company_name,
    timezone: parsed.data.timezone_name,
  };
}

/** Alle Benutzer der Firma (ungültige Einträge werden übersprungen) */
export async function listUsers(apiDomain: string, accessToken: string, f: Fetch = fetch): Promise<PipedriveUser[]> {
  const data = await apiGet(apiDomain, accessToken, "/api/v1/users", f);
  if (!Array.isArray(data)) return [];
  return data.flatMap((raw) => {
    const p = userSchema.safeParse(raw);
    return p.success ? [toUser(p.data)] : [];
  });
}
