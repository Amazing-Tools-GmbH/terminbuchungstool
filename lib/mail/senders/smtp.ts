import nodemailer from "nodemailer";
import { z } from "zod";
import { MailSendError, type MailMessage, type MailSender, type SendResult } from "../types";

/** Zugangsdaten (verschlüsselt in mail_connections.credentials_enc) */
export const smtpCredentialsSchema = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  /** true = TLS ab Verbindungsbeginn (465), false = STARTTLS (587) */
  secure: z.boolean(),
  user: z.string().min(1).max(320),
  pass: z.string().min(1).max(1000),
});
export type SmtpCredentials = z.infer<typeof smtpCredentialsSchema>;

type Transport = Pick<nodemailer.Transporter, "sendMail">;

export class SmtpMailSender implements MailSender {
  private readonly transport: Transport;

  constructor(creds: SmtpCredentials, transport?: Transport) {
    this.transport =
      transport ??
      nodemailer.createTransport({
        host: creds.host,
        port: creds.port,
        secure: creds.secure,
        requireTLS: !creds.secure,
        auth: { user: creds.user, pass: creds.pass },
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
      });
  }

  async send(m: MailMessage): Promise<SendResult> {
    try {
      const info = await this.transport.sendMail({
        from: { address: m.from.email, name: m.from.name ?? "" },
        to: { address: m.to.email, name: m.to.name ?? "" },
        replyTo: m.replyTo ? { address: m.replyTo.email, name: m.replyTo.name ?? "" } : undefined,
        subject: m.subject,
        html: m.html,
        text: m.text,
        attachments: m.attachments?.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content })),
      });
      return { messageId: info.messageId ?? null };
    } catch (err) {
      throw classifySmtpError(err);
    }
  }
}

/** SMTP-/Netzwerkfehler -> auth | transient | permanent */
export function classifySmtpError(err: unknown): MailSendError {
  const e = err as { code?: string; responseCode?: number; message?: string };
  const msg = e?.message ?? String(err);
  if (e?.code === "EAUTH" || e?.responseCode === 535 || e?.responseCode === 534 || e?.responseCode === 530) {
    return new MailSendError("auth", `Anmeldung am Postfach fehlgeschlagen: ${msg}`);
  }
  if (typeof e?.responseCode === "number") {
    if (e.responseCode >= 500) return new MailSendError("permanent", msg);
    return new MailSendError("transient", msg);
  }
  return new MailSendError("transient", msg);
}
