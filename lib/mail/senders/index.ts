import { decryptSecret } from "@/lib/crypto/secretbox";
import { MailSendError, type MailConnection, type MailSender } from "../types";
import { DevMailSender } from "./dev";
import { SmtpMailSender, smtpCredentialsSchema } from "./smtp";

export type SenderFactory = (connection: MailConnection) => MailSender;

/** Passende Implementierung je Anbieter. Google/Microsoft folgen (Phase 5). */
export const defaultSenderFactory: SenderFactory = (connection) => {
  switch (connection.provider) {
    case "dev":
      return new DevMailSender();
    case "smtp": {
      if (!connection.credentialsEnc) throw new MailSendError("auth", "SMTP-Zugangsdaten fehlen");
      let creds;
      try {
        creds = smtpCredentialsSchema.parse(JSON.parse(decryptSecret(connection.credentialsEnc)));
      } catch {
        throw new MailSendError("auth", "SMTP-Zugangsdaten nicht lesbar");
      }
      return new SmtpMailSender(creds);
    }
    case "google":
    case "microsoft":
      throw new MailSendError("auth", `Versand über ${connection.provider} ist noch nicht verfügbar`);
  }
};
