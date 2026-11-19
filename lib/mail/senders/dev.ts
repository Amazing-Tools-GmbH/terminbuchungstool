import { randomUUID } from "node:crypto";
import type { MailMessage, MailSender, SendResult } from "../types";

/**
 * Entwicklung: verschickt nichts. Der Outbox-Verarbeiter speichert die
 * gerenderte Mail in email_outbox.rendered; anzeigen unter /dev/mails.
 */
export class DevMailSender implements MailSender {
  async send(_message: MailMessage): Promise<SendResult> {
    return { messageId: `dev-${randomUUID()}` };
  }
}
