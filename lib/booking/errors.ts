import type { TextKey } from "@/lib/texts";

/** Fehlercodes der DB-Funktionen (message 'TB:<code>') */
export const BOOKING_ERROR_CODES = [
  "invitation_not_found",
  "invitation_expired",
  "event_not_available",
  "invalid_name",
  "invalid_email",
  "invalid_seats",
  "invalid_attendees",
  "invalid_guest_email",
  "change_deadline_passed",
  "slot_not_allowed",
  "slot_not_available",
  "not_enough_seats",
  "no_active_booking",
  "already_booked",
] as const;
export type BookingErrorCode = (typeof BOOKING_ERROR_CODES)[number];

export class BookingError extends Error {
  constructor(
    readonly code: BookingErrorCode,
    readonly detail?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "BookingError";
  }
}

/** Wandelt einen pg-Fehler in BookingError um (sonst null) */
export function toBookingError(err: unknown): BookingError | null {
  const e = err as { message?: string; detail?: string };
  if (!e?.message?.startsWith("TB:")) return null;
  const code = e.message.slice(3) as BookingErrorCode;
  if (!BOOKING_ERROR_CODES.includes(code)) return null;
  let detail: Record<string, unknown> | undefined;
  try {
    detail = e.detail ? JSON.parse(e.detail) : undefined;
  } catch {
    detail = undefined;
  }
  return new BookingError(code, detail);
}

export function httpStatusFor(code: BookingErrorCode): number {
  switch (code) {
    case "invitation_not_found":
      return 404;
    case "invitation_expired":
    case "event_not_available":
    case "change_deadline_passed":
      return 403;
    case "not_enough_seats":
    case "slot_not_available":
    case "slot_not_allowed":
    case "no_active_booking":
    case "already_booked":
      return 409;
    default:
      return 400;
  }
}

/** Text für die Oberfläche */
export function messageKeyFor(code: BookingErrorCode): TextKey {
  switch (code) {
    case "not_enough_seats":
      return "error.not_enough_seats";
    case "slot_not_available":
    case "slot_not_allowed":
      return "error.slot_not_available";
    case "invitation_expired":
      return "error.invitation_expired";
    case "change_deadline_passed":
      return "error.change_deadline_passed";
    case "invalid_email":
      return "error.invalid_email";
    case "invalid_name":
      return "error.invalid_name";
    case "invalid_attendees":
      return "error.invalid_attendees";
    case "invalid_guest_email":
      return "error.invalid_guest_email";
    case "already_booked":
      return "error.already_booked";
    default:
      return "error.generic";
  }
}
