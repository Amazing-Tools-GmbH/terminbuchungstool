/**
 * Welcher Weg verschickt eine Mail? (reine Logik, testbar)
 *
 *   Einladung (INVITE_MAIL_PROVIDER):
 *     pipedrive  über das in Pipedrive verbundene Postfach des Einladenden
 *     oauth      über sein per Google/Microsoft verbundenes Postfach
 *     smtp       System-Adresse, Anzeigename + Reply-To = Einladender, Smart BCC
 *     Fehlt etwas, gibt es einen Fehlercode für eine verständliche Meldung –
 *     nie einen stillen Wechsel auf einen anderen Weg.
 *   Bestätigung/Änderung/Stornierung (tenants.confirmation_mail_route):
 *     pipedrive  über das Pipedrive-Postfach des zuständigen Mitarbeiters
 *                (ohne .ics-Anhang; ohne zuständigen Mitarbeiter: System-Adresse;
 *                Mitarbeiter gesperrt: Fehlermeldung, kein stiller Wechsel)
 *     system     System-SMTP, Reply-To = Einladender, Smart BCC
 *   Testmail: genau das zu prüfende Postfach (vorher entschieden, nicht hier).
 */
import type { InviteMailProvider } from "./config";

export type Inviter = { userId: string; name: string | null; email: string | null; active: boolean };
export type RouteConnection = { id: string; status: "pending" | "active" | "error" | "revoked"; senderEmail: string };

export type MailRoute<C extends RouteConnection = RouteConnection> =
  | { kind: "system"; channel: "system" | "smtp"; fromName: string | null; replyTo: { email: string; name: string | null } | null }
  | { kind: "pipedrive"; channel: "pipedrive"; userId: string }
  | { kind: "connection"; channel: "oauth"; connection: C }
  | { kind: "error"; code: string; message: string };

export type ConfirmationRoute = "pipedrive" | "system";

export function routeMail<C extends RouteConnection>(
  type: "invitation" | "confirmation" | "cancellation",
  mode: InviteMailProvider,
  ctx: { inviter: Inviter | null; userConnection: C | null },
  confirmationRoute: ConfirmationRoute = "system",
): MailRoute<C> {
  const inviter = ctx.inviter?.active ? ctx.inviter : null;
  const inviterReply = inviter?.email ? { email: inviter.email, name: inviter.name } : null;

  if (type !== "invitation" && confirmationRoute === "pipedrive" && ctx.inviter) {
    // zuständiger Mitarbeiter bekannt: über sein Pipedrive-Postfach (oder klare Meldung)
    if (!inviter) return { kind: "error", code: "no_inviter", message: "Der zuständige Mitarbeiter ist nicht (mehr) freigeschaltet" };
    return { kind: "pipedrive", channel: "pipedrive", userId: inviter.userId };
  }
  if (type !== "invitation") {
    // Bestätigung/Stornierung: System-Adresse, Antworten an den Einladenden
    return { kind: "system", channel: "system", fromName: null, replyTo: inviterReply };
  }
  if (!inviter) {
    return { kind: "error", code: "no_inviter", message: "Einladung ohne aktiven einladenden Mitarbeiter" };
  }
  switch (mode) {
    case "pipedrive":
      return { kind: "pipedrive", channel: "pipedrive", userId: inviter.userId };
    case "oauth": {
      const c = ctx.userConnection;
      if (!c) return { kind: "error", code: "no_user_mailbox", message: "Kein eigenes Postfach verbunden (Google/Microsoft)" };
      if (c.status !== "active") {
        return { kind: "error", code: "user_mailbox_error", message: `Postfach ${c.senderEmail} ist nicht aktiv (${c.status})` };
      }
      return { kind: "connection", channel: "oauth", connection: c };
    }
    case "smtp":
      return { kind: "system", channel: "smtp", fromName: inviter.name ?? inviter.email, replyTo: inviterReply };
  }
}
