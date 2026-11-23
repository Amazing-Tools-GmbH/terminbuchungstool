/**
 * Versiegelte Werte für Anmeldung und Sitzung (reine Logik, ohne Next.js).
 *
 * Die Sitzung des Admin-Backends ist ein eigenes, mit AES-256-GCM
 * versiegeltes Cookie (kein Supabase-JWT): Der Server setzt die Identität
 * pro Abfrage selbst (withActor -> request.jwt.claims), damit greift RLS.
 *
 * Schlüssel: per HKDF aus ENCRYPTION_KEY abgeleitet, je Zweck ein eigener
 * Schlüssel. Ein Wert eines Zwecks (z. B. "state") lässt sich darum nie als
 * Wert eines anderen Zwecks (z. B. "session") verwenden.
 */
import { hkdfSync } from "node:crypto";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secretbox";

export type SealPurpose = "session" | "login-state" | "mail-state" | "panel";

function purposeKey(purpose: SealPurpose, rawKey: string | undefined): string {
  if (!rawKey) throw new Error("ENCRYPTION_KEY fehlt");
  const ikm = Buffer.from(rawKey, "base64");
  if (ikm.length !== 32) throw new Error("ENCRYPTION_KEY muss 32 Byte (base64) lang sein");
  return Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), `tb-${purpose}-v1`, 32)).toString("base64");
}

/** Versiegelt einen Wert mit Ablaufzeit (Sekunden ab jetzt). */
export function seal(purpose: SealPurpose, value: Record<string, unknown>, ttlSeconds: number, opts: { now?: number; key?: string } = {}): string {
  const now = opts.now ?? Date.now();
  const payload = JSON.stringify({ ...value, exp: Math.floor(now / 1000) + ttlSeconds });
  // base64url, damit der Wert ohne weiteres Escaping in URLs/Cookies passt
  return Buffer.from(encryptSecret(payload, purposeKey(purpose, opts.key ?? process.env.ENCRYPTION_KEY))).toString("base64url");
}

/** Öffnet einen versiegelten Wert; null bei Manipulation, falschem Zweck, Ablauf oder ungültigem Inhalt. */
export function unseal<T>(
  purpose: SealPurpose,
  sealed: string | null | undefined,
  schema: z.ZodType<T>,
  opts: { now?: number; key?: string } = {},
): T | null {
  if (!sealed || sealed.length > 4096) return null;
  let raw: unknown;
  try {
    const box = Buffer.from(sealed, "base64url").toString("utf8");
    raw = JSON.parse(decryptSecret(box, purposeKey(purpose, opts.key ?? process.env.ENCRYPTION_KEY)));
  } catch {
    return null;
  }
  const exp = (raw as { exp?: unknown })?.exp;
  if (typeof exp !== "number" || exp * 1000 <= (opts.now ?? Date.now())) return null;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------
// Inhalte
// ---------------------------------------------------------------------

export const SESSION_COOKIE = "tb_session";
export const LOGIN_NONCE_COOKIE = "tb_login_nonce";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
export const LOGIN_STATE_TTL_SECONDS = 10 * 60;

/** Sitzung: Benutzer (auth.users.id) für genau einen Mandanten */
export const sessionSchema = z.object({
  uid: z.string().uuid(),
  tid: z.string().uuid(),
  /** Pipedrive-Benutzer-ID; null beim Dev-Login */
  pd: z.number().int().positive().nullable(),
});
export type Session = z.infer<typeof sessionSchema>;

/**
 * OAuth-state des Logins: Nonce, der zusätzlich als Cookie auf der zentralen
 * Adresse liegt (Schutz vor untergeschobenen Logins). Der Mandant ergibt sich
 * erst nach der Anmeldung aus der Pipedrive-Firma (company_id).
 */
export const loginStateSchema = z.object({
  purpose: z.literal("login"),
  nonce: z.string().min(16).max(128),
});
export type LoginState = z.infer<typeof loginStateSchema>;

/**
 * OAuth-state beim (Neu-)Verbinden der Pipedrive-Firma aus dem Admin
 * (Admin → Pipedrive-Verbindung): an Mandant + angemeldeten Owner gebunden.
 */
export const relinkStateSchema = z.object({
  purpose: z.literal("relink"),
  nonce: z.string().min(16).max(128),
  tid: z.string().uuid(),
  uid: z.string().uuid(),
});
export type RelinkState = z.infer<typeof relinkStateSchema>;

/** OAuth-state beim Verbinden eines Postfachs (Google/Microsoft) */
export const MAIL_NONCE_COOKIE = "tb_mail_nonce";
export const mailStateSchema = z.object({
  purpose: z.literal("mail"),
  provider: z.enum(["google", "microsoft"]),
  scope: z.enum(["user", "tenant"]),
  tid: z.string().uuid(),
  uid: z.string().uuid(),
  nonce: z.string().min(16).max(128),
});
export type MailState = z.infer<typeof mailStateSchema>;

/**
 * Sitzung des Vertriebs-Panels (eingebettet in Pipedrive): kein Cookie
 * (Drittanbieter-Cookies sind in iframes unzuverlässig), sondern ein
 * versiegelter Wert, den der Browser als Bearer-Token mitschickt.
 */
export const PANEL_TTL_SECONDS = 2 * 60 * 60;
export const panelSessionSchema = sessionSchema.extend({ deal: z.number().int().positive() });
export type PanelSession = z.infer<typeof panelSessionSchema>;
