/**
 * Einstieg aus den Pipedrive-App-Einstellungen ("App settings"-Seite im
 * Developer Hub: <APP_BASE_URL>/settings). Pipedrive öffnet die Seite mit
 *   ?userId=<id>&companyId=<id>&token=<JWT>
 * Das JWT (HS256) enthält userId, companyId, iat, exp und ist mit einem
 * Geheimnis der App signiert: PIPEDRIVE_JWT_SECRET, sonst PIPEDRIVE_CLIENT_SECRET.
 * Reine Logik, ohne Abhängigkeiten (node:crypto).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

type Env = Record<string, string | undefined>;

export function settingsJwtSecret(env: Env = process.env): string | null {
  return env.PIPEDRIVE_JWT_SECRET?.trim() || env.PIPEDRIVE_CLIENT_SECRET?.trim() || null;
}

/** Ein Link aus Pipedrive ist frisch; ältere Tokens werden trotz exp abgelehnt (Weitergabe/Verlauf) */
export const SETTINGS_TOKEN_MAX_AGE_SECONDS = 15 * 60;
const LEEWAY_SECONDS = 60;

const headerSchema = z.object({ alg: z.literal("HS256"), typ: z.string().optional() });
const claimsSchema = z.object({
  userId: z.coerce.number().int().positive(),
  companyId: z.coerce.number().int().positive(),
  iat: z.number().int(),
  exp: z.number().int(),
});

export type SettingsIdentity = { userId: number; companyId: number };
export type SettingsTokenError = "missing" | "malformed" | "bad_signature" | "expired" | "too_old" | "mismatch" | "not_configured";

function b64json(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

export function verifySettingsToken(
  input: { token: string | null; userId: string | null; companyId: string | null },
  secret: string | null,
  now = Date.now(),
): { ok: true; identity: SettingsIdentity } | { ok: false; error: SettingsTokenError } {
  if (!secret) return { ok: false, error: "not_configured" };
  if (!input.token || !input.userId || !input.companyId) return { ok: false, error: "missing" };
  const parts = input.token.split(".");
  if (parts.length !== 3 || input.token.length > 2048) return { ok: false, error: "malformed" };
  const [h, p, sig] = parts as [string, string, string];

  let claims: z.infer<typeof claimsSchema>;
  try {
    // nur HS256 – verhindert "alg: none" und Algorithmus-Verwechslung
    if (!headerSchema.safeParse(b64json(h)).success) return { ok: false, error: "malformed" };
    const c = claimsSchema.safeParse(b64json(p));
    if (!c.success) return { ok: false, error: "malformed" };
    claims = c.data;
  } catch {
    return { ok: false, error: "malformed" };
  }

  const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, error: "bad_signature" };

  const nowS = Math.floor(now / 1000);
  if (claims.exp + LEEWAY_SECONDS < nowS) return { ok: false, error: "expired" };
  if (claims.iat - LEEWAY_SECONDS > nowS || nowS - claims.iat > SETTINGS_TOKEN_MAX_AGE_SECONDS) return { ok: false, error: "too_old" };
  if (String(claims.userId) !== input.userId.trim() || String(claims.companyId) !== input.companyId.trim()) {
    return { ok: false, error: "mismatch" };
  }
  return { ok: true, identity: { userId: claims.userId, companyId: claims.companyId } };
}
