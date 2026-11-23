import "server-only";
import { at, type PanelErrorCode } from "@/lib/texts/admin";

const STATUS: Partial<Record<PanelErrorCode, number>> = {
  session: 401,
  forbidden: 403,
  no_access: 403,
  disabled: 403,
  invalid_input: 400,
  no_contact: 409,
  not_enough_seats: 409,
  already_booked: 409,
  slot_not_available: 409,
  event_not_available: 409,
  pipedrive_unavailable: 503,
  generic: 500,
};

export function panelError(code: PanelErrorCode): Response {
  return Response.json({ ok: false, error: code, message: at(`panel.error.${code}`) }, { status: STATUS[code] ?? 400, headers: { "cache-control": "no-store" } });
}
