import { decryptSecret, encryptSecret } from "@/lib/crypto/secretbox";
import { mailOAuthConfig, oauthCredentialsSchema } from "../oauth";
import { MailSendError, type MailConnection, type MailSender } from "../types";
import { DevMailSender } from "./dev";
import { GoogleMailSender } from "./google";
import { MicrosoftMailSender } from "./microsoft";
import { SmtpMailSender, smtpCredentialsSchema } from "./smtp";
import { pipedriveMailTransport, type SystemMailConfig } from "../config";
import {
  McpPipedriveMailTransport,
  PipedriveMailSender,
  RestPipedriveMailTransport,
  type PipedriveMailAccess,
} from "@/lib/pipedrive/mail";

export type SenderContext = {
  /** speichert neue (verschlüsselte) Zugangsdaten, z. B. nach Token-Refresh */
  saveCredentials?: (credentialsEnc: string) => Promise<void>;
};

/** Wohin geht der Versand? */
export type SenderTarget =
  | { kind: "connection"; connection: MailConnection }
  | { kind: "system"; config: SystemMailConfig }
  | { kind: "pipedrive"; access: () => Promise<PipedriveMailAccess> };

export type SenderFactory = (target: SenderTarget, ctx?: SenderContext) => MailSender;

function readCredentials(connection: MailConnection): unknown {
  if (!connection.credentialsEnc) throw new MailSendError("auth", "Zugangsdaten des Postfachs fehlen");
  try {
    return JSON.parse(decryptSecret(connection.credentialsEnc));
  } catch {
    throw new MailSendError("auth", "Zugangsdaten des Postfachs nicht lesbar");
  }
}

/** Passende Implementierung je Ziel bzw. Anbieter */
export const defaultSenderFactory: SenderFactory = (target, ctx = {}) => {
  if (target.kind === "system") {
    return target.config.transport === "dev" ? new DevMailSender() : new SmtpMailSender(target.config.smtp);
  }
  if (target.kind === "pipedrive") {
    const transport = pipedriveMailTransport() === "rest" ? new RestPipedriveMailTransport() : new McpPipedriveMailTransport();
    return new PipedriveMailSender(target.access, transport);
  }
  const connection = target.connection;
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
