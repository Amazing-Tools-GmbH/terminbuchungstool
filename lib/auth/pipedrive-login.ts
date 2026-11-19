/**
 * "Mit Pipedrive anmelden" – Entscheidungslogik des OAuth-Callbacks.
 * Abhängigkeiten werden übergeben (Tests); die Verdrahtung mit DB und
 * Pipedrive steht in app/api/auth/pipedrive/callback/route.ts.
 *
 * Zugriff bekommt nur, wer
 *   1. zur Pipedrive-Firma gehört, mit der der Mandant verbunden ist,
 *   2. in der Nutzerverwaltung des Mandanten freigeschaltet ist (status active),
 *   3. dieselbe E-Mail hat wie der freigeschaltete auth-Benutzer.
 * Die Benutzer-Tokens werden verschlüsselt gespeichert: Mit dem Scope
 * mail-sending:full verschickt die App Einladungen in seinem Namen über Pipedrive.
 */
import type { PipedriveMe, PipedriveTokens } from "@/lib/pipedrive/client";
import type { LoginState, Session } from "./session";

export type LoginError = "oauth_failed" | "not_connected" | "wrong_company" | "no_access" | "disabled" | "email_mismatch";

export type MemberLookup = { userId: string; authEmail: string; status: "active" | "disabled" };

export type LoginDeps = {
  exchangeCode: (code: string) => Promise<PipedriveTokens>;
  getMe: (apiDomain: string, accessToken: string) => Promise<PipedriveMe>;
  connectedCompanyId: (tenantId: string) => Promise<number | null>;
  lookupMember: (tenantId: string, pipedriveUserId: number) => Promise<MemberLookup | null>;
  /** Name/E-Mail aus Pipedrive im Cache der Mitgliedschaft aktualisieren */
  refreshMemberCache: (tenantId: string, userId: string, me: PipedriveMe) => Promise<void>;
  /** Tokens des Mitarbeiters speichern (Versand von Einladungen über Pipedrive) */
  storeUserTokens: (tenantId: string, userId: string, me: PipedriveMe, tokens: PipedriveTokens) => Promise<void>;
};

export type LoginResult = { ok: true; session: Session } | { ok: false; error: LoginError };

export async function completePipedriveLogin(state: LoginState, code: string, deps: LoginDeps): Promise<LoginResult> {
  let me: PipedriveMe;
  let tokens: PipedriveTokens;
  try {
    tokens = await deps.exchangeCode(code);
    me = await deps.getMe(tokens.apiDomain, tokens.accessToken);
  } catch {
    return { ok: false, error: "oauth_failed" };
  }

  const companyId = await deps.connectedCompanyId(state.tid);
  if (companyId === null) return { ok: false, error: "not_connected" };
  if (companyId !== me.companyId) return { ok: false, error: "wrong_company" };

  const member = await deps.lookupMember(state.tid, me.id);
  if (!member) return { ok: false, error: "no_access" };
  if (member.status !== "active") return { ok: false, error: "disabled" };
  if (member.authEmail.toLowerCase() !== me.email.toLowerCase()) return { ok: false, error: "email_mismatch" };

  await deps.refreshMemberCache(state.tid, member.userId, me);
  await deps.storeUserTokens(state.tid, member.userId, me, tokens);
  return { ok: true, session: { uid: member.userId, tid: state.tid, pd: me.id } };
}
