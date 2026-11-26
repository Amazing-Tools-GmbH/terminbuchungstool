import "server-only";
/**
 * Hinweis auf der Login-Seite, wenn jemand (noch) keinen Zugriff hat: an wen
 * er sich wenden kann (aktive Owner). Versiegelt und kurzlebig in der Adresse,
 * damit keine E-Mail-Adresse im Klartext in Logs/Verlauf landet.
 */
import { LOGIN_HINT_TTL_SECONDS, loginHintSchema, seal, unseal } from "./session";
import { ownerContacts } from "@/lib/pipedrive/admin-sync";

export async function loginHintFor(tenantId: string): Promise<string | null> {
  try {
    const owners = await ownerContacts(tenantId);
    return owners.length ? seal("login-hint", { owners: owners.slice(0, 10) }, LOGIN_HINT_TTL_SECONDS) : null;
  } catch {
    return null;
  }
}

export function readLoginHint(v: string | null | undefined): string[] {
  return unseal("login-hint", v, loginHintSchema)?.owners ?? [];
}
