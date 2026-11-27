/**
 * Versand-Konfiguration aus Umgebungsvariablen (siehe .env.example).
 * Den Weg für Kundenmails wählt jeder Mandant selbst (tenants.mail_route,
 * lib/mail/routing.ts); hier steht nur, was der Betreiber einrichtet:
 *
 *   SYSTEM_MAIL_TRANSPORT = smtp | dev
 *     System-Absender (Bestätigungen, Einladungen beim Weg "system",
 *     Zugriffsanfragen). dev = nur in der DB ablegen (/dev/mails).
 *   GOOGLE_CLIENT_* / MICROSOFT_CLIENT_*
 *     Zugangsdaten für "Mit Google/Microsoft verbinden" unter E-Mail-Einstellungen → „Mein Postfach“.
 */
import { isProduction } from "@/lib/env-mode";
import { z } from "zod";
import { smtpCredentialsSchema, type SmtpCredentials } from "./senders/smtp";

type Env = Record<string, string | undefined>;

/** Sind die Google-/Microsoft-Buttons sichtbar? Nur mit eingetragenen Zugangsdaten. */
export function oauthProvidersVisible(env: Env = process.env): { google: boolean; microsoft: boolean } {
  return {
    google: Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim()),
    microsoft: Boolean(env.MICROSOFT_CLIENT_ID?.trim() && env.MICROSOFT_CLIENT_SECRET?.trim()),
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
