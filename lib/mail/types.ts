/** Versand über das Postfach des Mandanten – anbieterunabhängige Typen */

export type MailAddress = { email: string; name?: string | null };

export type MailAttachment = { filename: string; contentType: string; content: string };

export type MailMessage = {
  from: MailAddress;
  to: MailAddress;
  replyTo?: MailAddress | null;
  /** z. B. Pipedrive-Smart-BCC (Ablage der Mail beim Kontakt/Deal) */
  bcc?: MailAddress[];
  subject: string;
  html: string;
  text: string;
  attachments?: MailAttachment[];
};

export type SendResult = { messageId: string | null };

export interface MailSender {
  send(message: MailMessage): Promise<SendResult>;
}

/**
 * - auth:       Zugang ungültig (Passwort geändert, Token entzogen) -> Verbindung
 *               auf "error", Mail bleibt in der Outbox bis zur Erneuerung
 * - transient:  vorübergehend (Netz, 4xx-SMTP, Rate-Limit) -> Retry mit Backoff
 * - permanent:  Mail ist so nicht zustellbar (z. B. Empfänger ungültig) -> failed
 */
export type MailErrorKind = "auth" | "transient" | "permanent";

export class MailSendError extends Error {
  constructor(
    readonly kind: MailErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "MailSendError";
  }
}

export type MailProvider = "google" | "microsoft" | "smtp" | "dev";

export type MailConnection = {
  id: string;
  tenantId: string;
  provider: MailProvider;
  senderEmail: string;
  senderName: string | null;
  status: "pending" | "active" | "error" | "revoked";
  credentialsEnc: string | null;
};
