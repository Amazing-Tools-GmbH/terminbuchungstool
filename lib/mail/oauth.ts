/**
 * OAuth für den Mailversand über Google (Gmail API) und Microsoft (Graph).
 * Reine Logik mit austauschbarem fetch (Tests), ohne Datenbank.
 *
 * Wir fordern nur das Recht zum SENDEN an (kein Lesen von Mails):
 *   Google:    openid email https://www.googleapis.com/auth/gmail.send
 *   Microsoft: openid email offline_access User.Read Mail.Send
 * Callback-URLs (je eine für alle Mandanten):
 *   <APP_BASE_URL>/api/mail/oauth/google/callback
 *   <APP_BASE_URL>/api/mail/oauth/microsoft/callback
 */
import { z } from "zod";
import { MailSendError } from "./types";

type Fetch = typeof fetch;
type Env = Record<string, string | undefined>;

export type MailOAuthProviderId = "google" | "microsoft";
export const MAIL_OAUTH_PROVIDERS: readonly MailOAuthProviderId[] = ["google", "microsoft"];

export type MailOAuthConfig = { clientId: string; clientSecret: string; redirectUri: string };

export function mailOAuthConfig(provider: MailOAuthProviderId, env: Env = process.env): MailOAuthConfig | null {
  const prefix = provider === "google" ? "GOOGLE" : "MICROSOFT";
  const clientId = env[`${prefix}_CLIENT_ID`]?.trim();
  const clientSecret = env[`${prefix}_CLIENT_SECRET`]?.trim();
  if (!clientId || !clientSecret) return null;
  const base = (env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return { clientId, clientSecret, redirectUri: `${base}/api/mail/oauth/${provider}/callback` };
}

/** Gespeichert verschlüsselt in mail_connections.credentials_enc */
export const oauthCredentialsSchema = z.object({
  kind: z.literal("oauth"),
  refreshToken: z.string().min(1),
  accessToken: z.string().min(1).optional(),
  /** ISO-Zeitpunkt, ab dem das Access-Token als abgelaufen gilt */
  expiresAt: z.string().datetime().optional(),
});
export type OAuthCredentials = z.infer<typeof oauthCredentialsSchema>;

export type OAuthTokens = { accessToken: string; refreshToken: string | null; expiresAt: Date; scope: string | null; idToken: string | null };

export type ConnectedMailbox = {
  credentials: OAuthCredentials;
  email: string;
  name: string | null;
  grantedScopes: string | null;
};

export const GOOGLE_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const GOOGLE_SCOPES = ["openid", "email", GOOGLE_SEND_SCOPE];
const MICROSOFT_SCOPES = ["openid", "email", "offline_access", "https://graph.microsoft.com/User.Read", "https://graph.microsoft.com/Mail.Send"];

const ENDPOINTS = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    revoke: "https://oauth2.googleapis.com/revoke",
  },
  microsoft: {
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  },
} as const;

export function mailAuthorizeUrl(provider: MailOAuthProviderId, cfg: MailOAuthConfig, state: string, loginHint?: string | null): string {
  const u = new URL(ENDPOINTS[provider].authorize);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  if (provider === "google") {
    u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
    u.searchParams.set("access_type", "offline"); // Refresh-Token
    u.searchParams.set("prompt", "consent"); // Refresh-Token auch bei erneutem Verbinden
    u.searchParams.set("include_granted_scopes", "false");
  } else {
    u.searchParams.set("scope", MICROSOFT_SCOPES.join(" "));
    u.searchParams.set("response_mode", "query");
    u.searchParams.set("prompt", "select_account");
  }
  if (loginHint) u.searchParams.set("login_hint", loginHint);
  return u.toString();
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().int().positive(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});

async function tokenRequest(provider: MailOAuthProviderId, cfg: MailOAuthConfig, body: Record<string, string>, f: Fetch): Promise<OAuthTokens> {
  const params = new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...body });
  if (provider === "microsoft") params.set("scope", MICROSOFT_SCOPES.join(" "));
  let res: Response;
  try {
    res = await f(ENDPOINTS[provider].token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  } catch (err) {
    throw new MailSendError("transient", `Anmeldedienst nicht erreichbar: ${(err as Error).message}`);
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
  if (!res.ok) {
    // invalid_grant = Zugang widerrufen/abgelaufen/Passwort geändert -> neu verbinden
    if (json.error === "invalid_grant" || json.error === "unauthorized_client" || res.status === 401) {
      throw new MailSendError("auth", `Zugang zum Postfach ungültig (${json.error ?? res.status}) – bitte neu verbinden`);
    }
    if (res.status >= 500 || res.status === 429) throw new MailSendError("transient", `Anmeldedienst-Fehler (${res.status})`);
    throw new MailSendError("auth", `Anmeldung abgelehnt (${json.error ?? res.status})`);
  }
  const t = tokenResponseSchema.safeParse(json);
  if (!t.success) throw new MailSendError("transient", "Unerwartete Antwort des Anmeldedienstes");
  return {
    accessToken: t.data.access_token,
    refreshToken: t.data.refresh_token ?? null,
    expiresAt: new Date(Date.now() + Math.max(60, t.data.expires_in - 60) * 1000),
    scope: t.data.scope ?? null,
    idToken: t.data.id_token ?? null,
  };
}

export function refreshMailTokens(provider: MailOAuthProviderId, cfg: MailOAuthConfig, refreshToken: string, f: Fetch = fetch): Promise<OAuthTokens> {
  return tokenRequest(provider, cfg, { grant_type: "refresh_token", refresh_token: refreshToken }, f);
}

/**
 * Claims des ID-Tokens. Es kommt direkt per TLS vom Token-Endpunkt des
 * Anbieters (nicht über den Browser) – laut OpenID Connect genügt dann die
 * TLS-Prüfung, eine Signaturprüfung ist nicht nötig.
 */
export function idTokenClaims(idToken: string | null): Record<string, unknown> {
  if (!idToken) return {};
  const part = idToken.split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export class MailConnectError extends Error {
  constructor(readonly code: "oauth_failed" | "scope_missing" | "no_email" | "no_refresh_token") {
    super(code);
    this.name = "MailConnectError";
  }
}

const graphMeSchema = z.object({
  displayName: z.string().nullable().optional(),
  mail: z.string().nullable().optional(),
  userPrincipalName: z.string().nullable().optional(),
});

/** Code einlösen und Postfach-Adresse ermitteln */
export async function connectMailbox(
  provider: MailOAuthProviderId,
  cfg: MailOAuthConfig,
  code: string,
  f: Fetch = fetch,
): Promise<ConnectedMailbox> {
  let tokens: OAuthTokens;
  try {
    tokens = await tokenRequest(provider, cfg, { grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri }, f);
  } catch {
    throw new MailConnectError("oauth_failed");
  }
  if (!tokens.refreshToken) throw new MailConnectError("no_refresh_token");

  let email: string | null = null;
  let name: string | null = null;
  if (provider === "google") {
    // Google erlaubt das Abwählen einzelner Rechte – ohne gmail.send kein Versand
    if (!tokens.scope?.split(" ").includes(GOOGLE_SEND_SCOPE)) throw new MailConnectError("scope_missing");
    const c = idTokenClaims(tokens.idToken);
    if (typeof c.email === "string" && c.email_verified !== false) email = c.email;
    name = typeof c.name === "string" ? c.name : null;
  } else {
    const res = await f("https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName", {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    }).catch(() => null);
    const me = res?.ok ? graphMeSchema.safeParse(await res.json()) : null;
    if (me?.success) {
      email = me.data.mail || (me.data.userPrincipalName?.includes("@") ? me.data.userPrincipalName : null) || null;
      name = me.data.displayName ?? null;
    }
  }
  if (!email || !z.string().email().safeParse(email).success) throw new MailConnectError("no_email");

  return {
    credentials: { kind: "oauth", refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, expiresAt: tokens.expiresAt.toISOString() },
    email: email.toLowerCase(),
    name,
    grantedScopes: tokens.scope,
  };
}

/** Zugang beim Anbieter widerrufen (best effort; Microsoft bietet dafür keinen Endpunkt) */
export async function revokeMailAccess(provider: MailOAuthProviderId, creds: OAuthCredentials, f: Fetch = fetch): Promise<void> {
  if (provider !== "google") return;
  await f(`${ENDPOINTS.google.revoke}?token=${encodeURIComponent(creds.refreshToken)}`, { method: "POST" }).catch(() => undefined);
}
