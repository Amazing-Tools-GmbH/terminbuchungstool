/** Fehler des Admin-Backends; Texte in lib/texts/admin.ts (adminErrorText) */
export const ADMIN_ERROR_CODES = [
  "forbidden",
  "not_found",
  "invalid_input",
  "last_owner",
  "capacity_below_booked",
  "slot_in_past",
  "self",
  "already_member",
  "pipedrive_unavailable",
  "pipedrive_user_not_found",
  "mail_not_configured",
  "mail_oauth_failed",
  "mail_scope_missing",
  "mail_no_email",
  "mail_no_refresh_token",
  "mail_expired",
  "logo_invalid",
  "logo_too_large",
  "logo_upload_failed",
  "contrast_too_low",
  "template_invalid",
  "pipedrive_not_connected",
  "pipedrive_unauthorized",
  "pipedrive_company_in_use",
  "pipedrive_email_mismatch",
  "pipedrive_relink_failed",
  "generic",
] as const;
export type AdminErrorCode = (typeof ADMIN_ERROR_CODES)[number];

export class AdminError extends Error {
  constructor(readonly code: AdminErrorCode) {
    super(code);
    this.name = "AdminError";
  }
}

export function isAdminErrorCode(v: unknown): v is AdminErrorCode {
  return typeof v === "string" && (ADMIN_ERROR_CODES as readonly string[]).includes(v);
}

/** pg-Fehler -> AdminError (TB:-Codes aus Triggern, RLS-/Rechte-Verletzungen) */
export function toAdminError(err: unknown): AdminError {
  if (err instanceof AdminError) return err;
  const e = err as { message?: string; code?: string };
  if (e?.message === "TB:last_owner") return new AdminError("last_owner");
  if (e?.message === "TB:capacity_below_booked") return new AdminError("capacity_below_booked");
  if (e?.message === "TB:forbidden") return new AdminError("forbidden");
  if (e?.message?.startsWith("TB:") && isAdminErrorCode(e.message.slice(3))) return new AdminError(e.message.slice(3) as AdminErrorCode);
  if (e?.code === "42501") return new AdminError("forbidden"); // RLS/Rechte
  if (e?.code === "23514" || e?.code === "22007" || e?.code === "22008") return new AdminError("invalid_input");
  console.error("Admin-Fehler:", err);
  return new AdminError("generic");
}
