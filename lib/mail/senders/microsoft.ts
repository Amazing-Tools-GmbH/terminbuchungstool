/** Versand über Microsoft Graph (/me/sendMail) – Mail liegt danach unter "Gesendete Elemente". */
import { MailSendError, type MailAddress, type MailMessage, type MailSender, type SendResult } from "../types";
import { classifyHttp, OAuthTokenSource, type OAuthSenderDeps } from "./oauth-token";

export const GRAPH_SEND_URL = "https://graph.microsoft.com/v1.0/me/sendMail";

const recipient = (a: MailAddress) => ({ emailAddress: { address: a.email, ...(a.name ? { name: a.name } : {}) } });

/** Graph-Nutzlast (exportiert für Tests) */
export function graphMessage(m: MailMessage) {
  return {
    message: {
      subject: m.subject,
      body: { contentType: "HTML", content: m.html },
      toRecipients: [recipient(m.to)],
      ...(m.bcc?.length ? { bccRecipients: m.bcc.map(recipient) } : {}),
      ...(m.replyTo ? { replyTo: [recipient(m.replyTo)] } : {}),
      attachments: (m.attachments ?? []).map((a) => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: a.filename,
        contentType: a.contentType,
        contentBytes: Buffer.from(a.content, "utf8").toString("base64"),
      })),
    },
    saveToSentItems: true,
  };
}

export class MicrosoftMailSender implements MailSender {
  private readonly tokens: OAuthTokenSource;
  constructor(deps: Omit<OAuthSenderDeps, "provider">) {
    this.tokens = new OAuthTokenSource({ ...deps, provider: "microsoft" });
  }

  async send(m: MailMessage): Promise<SendResult> {
    const body = JSON.stringify(graphMessage(m));
    const attempt = async (force: boolean) => {
      const token = await this.tokens.accessToken(force);
      return this.tokens.fetch(GRAPH_SEND_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
      });
    };
    let res: Response;
    try {
      res = await attempt(false);
      if (res.status === 401) res = await attempt(true);
    } catch (err) {
      if (err instanceof MailSendError) throw err;
      throw new MailSendError("transient", `Microsoft Graph nicht erreichbar: ${(err as Error).message}`);
    }
    // 202 Accepted, ohne Message-ID
    if (!res.ok) throw classifyHttp(res.status, (await res.text().catch(() => "")).slice(0, 300));
    return { messageId: null };
  }
}
