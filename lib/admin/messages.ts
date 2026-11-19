/** ?ok=…/?error=… aus Redirects der Server Actions -> Text */
import { isAdminErrorCode } from "./errors";
import { adminErrorText, at, type AdminTextKey } from "@/lib/texts/admin";

const OK: Record<string, AdminTextKey> = {
  connected: "mailbox.ok.connected",
  test: "mailbox.ok.test",
  disconnected: "mailbox.ok.disconnected",
  smartBcc: "mailbox.ok.smartBcc",
  saved: "users.saved",
};

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function flashMessages(sp: Search): { ok: string | null; error: string | null } {
  const ok = one(sp.ok);
  const error = one(sp.error);
  return {
    ok: ok && OK[ok] ? at(OK[ok]) : null,
    error: error ? adminErrorText(isAdminErrorCode(error) ? error : "generic") : null,
  };
}
