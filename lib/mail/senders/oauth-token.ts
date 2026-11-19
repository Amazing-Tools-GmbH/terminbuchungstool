/**
 * Access-Token für Gmail/Graph: aus dem Cache der Zugangsdaten oder per
 * Refresh-Token neu holen. Neue Zugangsdaten (Microsoft rotiert das
 * Refresh-Token) werden über onCredentials gespeichert.
 */
import { refreshMailTokens, type MailOAuthConfig, type MailOAuthProviderId, type OAuthCredentials } from "../oauth";
import { MailSendError } from "../types";

export type OAuthSenderDeps = {
  provider: MailOAuthProviderId;
  config: MailOAuthConfig | null;
  credentials: OAuthCredentials;
  fetch?: typeof fetch;
  /** speichert aktualisierte Zugangsdaten (verschlüsselt) */
  onCredentials?: (c: OAuthCredentials) => Promise<void>;
};

export class OAuthTokenSource {
  private creds: OAuthCredentials;
  constructor(private readonly deps: OAuthSenderDeps) {
    this.creds = deps.credentials;
  }

  get fetch(): typeof fetch {
    return this.deps.fetch ?? fetch;
  }

  /** gültiges Access-Token; force = trotz Cache neu holen (nach 401) */
  async accessToken(force = false): Promise<string> {
    const valid = this.creds.accessToken && this.creds.expiresAt && Date.parse(this.creds.expiresAt) > Date.now() + 30_000;
    if (valid && !force) return this.creds.accessToken!;
    if (!this.deps.config) {
      throw new MailSendError("transient", `OAuth-App für ${this.deps.provider} ist nicht konfiguriert (Client-ID/Secret fehlen)`);
    }
    const t = await refreshMailTokens(this.deps.provider, this.deps.config, this.creds.refreshToken, this.fetch);
    this.creds = {
      kind: "oauth",
      refreshToken: t.refreshToken ?? this.creds.refreshToken,
      accessToken: t.accessToken,
      expiresAt: t.expiresAt.toISOString(),
    };
    await this.deps.onCredentials?.(this.creds);
    return t.accessToken;
  }
}

/** HTTP-Status einer Versand-API -> Fehlerart */
export function classifyHttp(status: number, detail: string): MailSendError {
  // Gmail meldet Kontingente/Ratenlimits teils als 403 (rateLimitExceeded, dailyLimitExceeded …)
  if (status === 403 && /rate ?limit|quota|limit ?exceeded/i.test(detail)) {
    return new MailSendError("transient", `Versandlimit des Postfachs erreicht (${status})`);
  }
  if (status === 401 || status === 403) return new MailSendError("auth", `Postfach verweigert den Versand (${status}): ${detail}`);
  if (status === 429 || status >= 500) return new MailSendError("transient", `Versanddienst vorübergehend nicht verfügbar (${status})`);
  return new MailSendError("permanent", `Versand abgelehnt (${status}): ${detail}`);
}
