/**
 * Welcher Weg verschickt eine Mail? (reine Logik, testbar)
 *
 * Einstellung je Mandant (tenants.mail_route, Admin → E-Mail):
 *   system    Einladung: System-Adresse, Anzeigename + Reply-To = Einladender.
 *             Bestätigung/Stornierung: System-Adresse, Reply-To = Einladender.
 *   employee  Einladung, Bestätigung und Stornierung über das eigene Postfach
 *             des einladenden Mitarbeiters (E-Mail-Einstellungen → "Mein Postfach": Google, Microsoft
 *             oder SMTP). Fehlt es oder ist es gestört, gibt es einen
 *             Fehlercode für eine verständliche Meldung – nie einen stillen
 *             Wechsel auf die System-Adresse.
 *   Testmail und interne Mails (Zugriffsanfragen) entscheidet die Outbox.
 */
export type MailRouteSetting = "system" | "employee";
export const MAIL_ROUTES: readonly MailRouteSetting[] = ["system", "employee"];

export function parseMailRoute(v: unknown): MailRouteSetting {
  return v === "employee" ? "employee" : "system";
}

export type Inviter = { userId: string; name: string | null; email: string | null; active: boolean };
export type RouteConnection = { id: string; status: "pending" | "active" | "error" | "revoked"; senderEmail: string };

export type MailRoute<C extends RouteConnection = RouteConnection> =
  | { kind: "system"; channel: "system" | "smtp"; fromName: string | null; replyTo: { email: string; name: string | null } | null }
  | { kind: "connection"; channel: "oauth"; connection: C }
  | { kind: "error"; code: string; message: string };

export function routeMail<C extends RouteConnection>(
  type: "invitation" | "confirmation" | "cancellation",
  setting: MailRouteSetting,
  ctx: { inviter: Inviter | null; userConnection: C | null },
): MailRoute<C> {
  const inviter = ctx.inviter?.active ? ctx.inviter : null;
  const inviterReply = inviter?.email ? { email: inviter.email, name: inviter.name } : null;

  if (setting === "employee") {
    if (!inviter) return { kind: "error", code: "no_inviter", message: "Kein aktiver einladender Mitarbeiter" };
    const c = ctx.userConnection;
    if (!c) return { kind: "error", code: "no_user_mailbox", message: "Kein eigenes Postfach verbunden" };
    if (c.status !== "active") {
      return { kind: "error", code: "user_mailbox_error", message: `Postfach ${c.senderEmail} ist nicht aktiv (${c.status})` };
    }
    return { kind: "connection", channel: "oauth", connection: c };
  }

  if (type !== "invitation") {
    // Bestätigung/Stornierung: System-Adresse, Antworten an den Einladenden
    return { kind: "system", channel: "system", fromName: null, replyTo: inviterReply };
  }
  if (!inviter) return { kind: "error", code: "no_inviter", message: "Einladung ohne aktiven einladenden Mitarbeiter" };
  return { kind: "system", channel: "smtp", fromName: inviter.name ?? inviter.email, replyTo: inviterReply };
}
