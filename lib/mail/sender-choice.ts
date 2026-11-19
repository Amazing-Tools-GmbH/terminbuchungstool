/**
 * Welches Postfach verschickt eine Mail? (reine Logik, testbar)
 *
 *   Einladung:     Postfach des einladenden Mitarbeiters; hat er keins, das
 *                  Firmenpostfach. Ist sein Postfach gestört, WARTET die Mail
 *                  (er hat sie selbst ausgelöst und sieht den Hinweis).
 *   Bestätigung/   Postfach dessen, der eingeladen hat; hat er keins, das
 *   Stornierung:   Firmenpostfach. Ist sein Postfach gestört, geht die Mail
 *                  über das Firmenpostfach – sichtbar vermerkt, damit der
 *                  Kunde nicht auf seine Bestätigung warten muss.
 *   Testmail:      immer genau das zu prüfende Postfach (nicht hier).
 */
export type ChoiceConnection = { id: string; status: "pending" | "active" | "error" | "revoked"; senderEmail: string };

export type SenderChoice<C extends ChoiceConnection = ChoiceConnection> =
  | { kind: "send"; connection: C; fallbackReason: string | null }
  | { kind: "blocked"; reason: string };

const STATUS_TEXT: Record<ChoiceConnection["status"], string> = {
  pending: "noch nicht bestätigt",
  active: "aktiv",
  error: "gestört",
  revoked: "getrennt",
};

export function chooseSender<C extends ChoiceConnection>(
  type: "invitation" | "confirmation" | "cancellation",
  conns: { user: C | null; tenant: C | null },
): SenderChoice<C> {
  const { user, tenant } = conns;
  if (user?.status === "active") return { kind: "send", connection: user, fallbackReason: null };

  if (user && type === "invitation") {
    return { kind: "blocked", reason: `Postfach ${user.senderEmail} ist ${STATUS_TEXT[user.status]} – Einladung wartet, bis es wieder verbunden ist` };
  }
  if (tenant?.status === "active") {
    return {
      kind: "send",
      connection: tenant,
      fallbackReason: user ? `Postfach ${user.senderEmail} war ${STATUS_TEXT[user.status]} – über das Firmenpostfach gesendet` : null,
    };
  }
  return {
    kind: "blocked",
    reason: tenant ? `Firmenpostfach ${tenant.senderEmail} ist ${STATUS_TEXT[tenant.status]}` : "Kein Postfach verbunden",
  };
}
