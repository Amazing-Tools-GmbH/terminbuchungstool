import { decryptSecret, encryptSecret } from "@/lib/crypto/secretbox";
import { mailOAuthConfig, oauthCredentialsSchema } from "../oauth";
import { MailSendError, type MailConnection, type MailSender } from "../types";
import { DevMailSender } from "./dev";
import { GoogleMailSender } from "./google";
import { MicrosoftMailSender } from "./microsoft";
import { SmtpMailSender, smtpCredentialsSchema } from "./smtp";

export type SenderContext = {
  /** speichert neue (verschlüsselte) Zugangsdaten, z. B. nach Token-Refresh */
  saveCredentials?: (credentialsEnc: string) => Promise<void>;
};

export type SenderFactory = (connection: MailConnection, ctx?: SenderContext) => MailSender;

function readCredentials(connection: MailConnection): unknown {
  if (!connection.credentialsEnc) throw new MailSendError("auth", "Zugangsdaten des Postfachs fehlen");
  try {
    return JSON.parse(decryptSecret(connection.credentialsEnc));
  } catch {
    throw new MailSendError("auth", "Zugangsdaten des Postfachs nicht lesbar");
  }
}

/** Passende Implementierung je Anbieter */
export const defaultSenderFactory: SenderFactory = (connection, ctx = {}) => {
  switch (connection.provider) {
    case "dev":
      return new DevMailSender();
    case "smtp": {
      const creds = smtpCredentialsSchema.safeParse(readCredentials(connection));
      if (!creds.success) throw new MailSendError("auth", "SMTP-Zugangsdaten ungültig");
      return new SmtpMailSender(creds.data);
    }
    case "google":
    case "microsoft": {
      const creds = oauthCredentialsSchema.safeParse(readCredentials(connection));
      if (!creds.success) throw new MailSendError("auth", "OAuth-Zugangsdaten ungültig");
      const deps = {
        config: mailOAuthConfig(connection.provider),
        credentials: creds.data,
        onCredentials: ctx.saveCredentials ? (c: unknown) => ctx.saveCredentials!(encryptSecret(JSON.stringify(c))) : undefined,
      };
      return connection.provider === "google" ? new GoogleMailSender(deps) : new MicrosoftMailSender(deps);
    }
  }
};
