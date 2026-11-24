/**
 * Versandwege (explizit über Umgebungsvariablen, siehe .env.example):
 *
 *   INVITE_MAIL_PROVIDER = smtp (Standard) | oauth | pipedrive
 *     pipedrive geht mit unserer Pipedrive-App NICHT: Pipedrive bietet Apps keinen
 *     Scope zum Senden (nur mail:read / mail:full). Bleibt nur für Tests/Altbestand.
 *     Weg für Einladungen. Schlägt er fehl, gibt es eine Meldung – nie einen
 *     stillen Wechsel auf einen anderen Weg.
 *   SYSTEM_MAIL_TRANSPORT = smtp | dev
 *     System-Absender für Bestätigungen (und Einladungen bei "smtp").
 *     dev = nur in der DB ablegen (/dev/mails).
 */
import { isProduction } from "@/lib/env-mode";
import { z } from "zod";
import { smtpCredentialsSchema, type SmtpCredentials } from "./senders/smtp";

type Env = Record<string, string | undefined>;

export type InviteMailProvider = "pipedrive" | "oauth" | "smtp";

export function inviteMailProvider(env: Env = process.env): InviteMailProvider {
  const v = env.INVITE_MAIL_PROVIDER?.trim();
  if (!v) return "smtp";
  if (v === "pipedrive" || v === "oauth" || v === "smtp") return v;
  throw new Error(`INVITE_MAIL_PROVIDER ungültig: ${v} (pipedrive | oauth | smtp)`);
}

/** Sind die Google-/Microsoft-Buttons sichtbar? Nur bei "oauth" und eingetragenen Zugangsdaten. */
export function oauthProvidersVisible(env: Env = process.env): { google: boolean; microsoft: boolean } {
  const on = inviteMailProvider(env) === "oauth";
  return {
    google: on && Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim()),
    microsoft: on && Boolean(env.MICROSOFT_CLIENT_ID?.trim() && env.MICROSOFT_CLIENT_SECRET?.trim()),
  };
}

export type SystemMailConfig =
  | { transport: "dev"; fromEmail: string; fromName: string | null }
  | { transport: "smtp"; fromEmail: string; fromName: string | null; smtp: SmtpCredentials };

/** System-Absender; null = nicht (vollständig) konfiguriert -> Mails warten */
export function systemMailConfig(env: Env = process.env): SystemMailConfig | null {
  const fromEmail = env.SYSTEM_MAIL_FROM?.trim().toLowerCase();
  if (!fromEmail || !z.string().email().safeParse(fromEmail).success) return null;
  const fromName = env.SYSTEM_MAIL_FROM_NAME?.trim() || null;
  const transport = env.SYSTEM_MAIL_TRANSPORT?.trim() || "smtp";
  if (transport === "dev") {
    if (isProduction(env)) return null; // nie in Produktion
    return { transport: "dev", fromEmail, fromName };
  }
  if (transport !== "smtp") return null;
  const smtp = smtpCredentialsSchema.safeParse({
    host: env.SYSTEM_SMTP_HOST?.trim(),
    port: Number(env.SYSTEM_SMTP_PORT ?? 587),
    secure: (env.SYSTEM_SMTP_SECURE ?? "false").trim() === "true",
    user: env.SYSTEM_SMTP_USER?.trim(),
    pass: env.SYSTEM_SMTP_PASS,
  });
  return smtp.success ? { transport: "smtp", fromEmail, fromName, smtp: smtp.data } : null;
}

export type PipedriveMailTransportKind = "mcp" | "rest";

/** Wie die App über Pipedrive sendet (beides OAuth mit mail-sending:full; siehe lib/pipedrive/mail.ts) */
export function pipedriveMailTransport(env: Env = process.env): PipedriveMailTransportKind {
  const v = env.PIPEDRIVE_MAIL_TRANSPORT?.trim();
  return v === "rest" ? "rest" : "mcp";
}
