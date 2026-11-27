import { NextResponse, type NextRequest } from "next/server";
import { mailStateSchema, unseal } from "@/lib/auth/session";
import { appUrl } from "@/lib/auth/urls";
import { connectMailbox, mailOAuthConfig, MailConnectError } from "@/lib/mail/oauth";
import { storePendingMailbox } from "@/lib/mail/connect";

export const dynamic = "force-dynamic";

/**
 * Zentraler OAuth-Callback (unter APP_BASE_URL, eine URL je Anbieter für alle
 * Mandanten). Löst den Code ein, legt das Ergebnis kurz im Zwischenspeicher
 * ab und schließt dann mit Sitzung + Nonce ab (/api/mail/oauth/finish).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const q = req.nextUrl.searchParams;
  const state = unseal("mail-state", q.get("state"), mailStateSchema);
  if (!state || state.provider !== provider) {
    return new NextResponse("Verbindung abgelaufen oder ungültig. Bitte im Admin-Backend erneut starten.", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const back = "/admin/email";
  const fail = (error: string) => NextResponse.redirect(appUrl(back, { error }));
  const cfg = mailOAuthConfig(state.provider);
  const code = q.get("code");
  if (!cfg) return fail("mail_not_configured");
  if (!code) return fail("mail_oauth_failed"); // abgebrochen oder abgelehnt

  try {
    const mailbox = await connectMailbox(state.provider, cfg, code);
    const pendingId = await storePendingMailbox(state, mailbox);
    return NextResponse.redirect(appUrl("/api/mail/oauth/finish", { pending: pendingId }));
  } catch (err) {
    if (err instanceof MailConnectError) return fail(`mail_${err.code}`);
    console.error("Postfach verbinden fehlgeschlagen:", (err as Error).message);
    return fail("mail_oauth_failed");
  }
}
