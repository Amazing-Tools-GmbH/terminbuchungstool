/** Versand über die Gmail API (users.messages.send) – Mail liegt danach im Ordner "Gesendet". */
import { buildMime } from "../mime";
import { MailSendError, type MailMessage, type MailSender, type SendResult } from "../types";
import { classifyHttp, OAuthTokenSource, type OAuthSenderDeps } from "./oauth-token";

export const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export class GoogleMailSender implements MailSender {
  private readonly tokens: OAuthTokenSource;
  constructor(deps: Omit<OAuthSenderDeps, "provider">) {
    this.tokens = new OAuthTokenSource({ ...deps, provider: "google" });
  }

  async send(m: MailMessage): Promise<SendResult> {
    const raw = (await buildMime(m)).toString("base64url");
    const attempt = async (force: boolean) => {
      const token = await this.tokens.accessToken(force);
      return this.tokens.fetch(GMAIL_SEND_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ raw }),
      });
    };
    let res: Response;
    try {
      res = await attempt(false);
      if (res.status === 401) res = await attempt(true); // Token abgelaufen/widerrufen? Einmal neu holen
    } catch (err) {
      if (err instanceof MailSendError) throw err;
      throw new MailSendError("transient", `Gmail nicht erreichbar: ${(err as Error).message}`);
    }
    if (!res.ok) throw classifyHttp(res.status, (await res.text().catch(() => "")).slice(0, 300));
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { messageId: body.id ?? null };
  }
}
