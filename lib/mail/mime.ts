/**
 * Gemeinsame Umwandlung unserer MailMessage in nodemailer-Optionen (SMTP)
 * bzw. eine fertige MIME-Nachricht (Gmail API erwartet RFC 822, base64url).
 */
import MailComposer from "nodemailer/lib/mail-composer";
import type Mail from "nodemailer/lib/mailer";
import type { MailAddress, MailMessage } from "./types";

const addr = (a: MailAddress) => ({ address: a.email, name: a.name ?? "" });

export function toNodemailerOptions(m: MailMessage): Mail.Options {
  return {
    from: addr(m.from),
    to: addr(m.to),
    bcc: m.bcc?.length ? m.bcc.map(addr) : undefined,
    replyTo: m.replyTo ? addr(m.replyTo) : undefined,
    subject: m.subject,
    html: m.html,
    text: m.text,
    attachments: m.attachments?.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content })),
  };
}

/** MIME-Nachricht inkl. Bcc-Kopfzeile (Gmail entfernt sie beim Versand selbst) */
export async function buildMime(m: MailMessage): Promise<Buffer> {
  const node = new MailComposer(toNodemailerOptions(m)).compile();
  node.keepBcc = true;
  return node.build();
}
