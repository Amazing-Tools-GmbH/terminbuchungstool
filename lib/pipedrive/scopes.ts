/** Scope-Liste aus Pipedrive (Leerzeichen- oder kommagetrennt) */
export function parseScopes(scopes: string | null | undefined): string[] {
  return (scopes ?? "").split(/[\s,]+/).filter(Boolean);
}

export const MAIL_SENDING_SCOPE = "mail-sending:full";

export function canSendMail(scopes: string | null | undefined): boolean {
  return parseScopes(scopes).includes(MAIL_SENDING_SCOPE);
}
