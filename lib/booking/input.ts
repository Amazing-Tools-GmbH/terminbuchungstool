import { z } from "zod";

/** Weiterer Teilnehmer mit eigener Einladung (eigener Link zum Absagen) */
export const guestInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(254),
});
export type GuestInput = z.infer<typeof guestInputSchema>;

/** Eingaben der Buchungs-API (Client -> Server). Die DB prüft zusätzlich. */
export const bookInputSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{20,200}$/),
  slotId: z.string().uuid(),
  seats: z.number().int().min(1).max(1000),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(254),
  /** Namen aller weiteren Teilnehmer */
  extraAttendees: z.array(z.string().trim().max(200)).max(999).default([]),
  /** davon die, die eine eigene Einladung bekommen (Name muss in extraAttendees stehen) */
  guests: z.array(guestInputSchema).max(999).default([]),
});
export type BookInput = z.infer<typeof bookInputSchema>;

/** Buchen über den öffentlichen Event-Link: zusätzlich optional die Firma */
export const publicBookInputSchema = bookInputSchema.extend({
  organization: z
    .string()
    .trim()
    .max(200)
    .default("")
    .transform((v) => v || null),
});
export type PublicBookInput = z.infer<typeof publicBookInputSchema>;

/** Name und E-Mail je weiterem Teilnehmer (E-Mail nur mit Einladung, je Zeile optional) */
export type AttendeeRow = { name: string; email: string };

export type AttendeeCheck =
  | { ok: true; extraAttendees: string[]; guests: GuestInput[] }
  | { ok: false; error: "invalid_attendees" | "invalid_guest_email" | "missing_guest_name" };

/**
 * Formularzeilen -> Namen aller weiteren Teilnehmer + die mit eigener Einladung
 * (Zeilen mit E-Mail). Leere Zeilen zählen nicht; ohne Einladung zählen E-Mails nicht.
 */
export function checkAttendees(rows: AttendeeRow[], seats: number, invite: boolean, bookerEmail: string): AttendeeCheck {
  const filled = rows
    .map((r) => ({ name: r.name.trim(), email: invite ? r.email.trim().toLowerCase() : "" }))
    .filter((r) => r.name || r.email);
  if (filled.length > seats - 1) return { ok: false, error: "invalid_attendees" };
  const seen = new Set([bookerEmail.trim().toLowerCase()].filter(Boolean));
  const guests: GuestInput[] = [];
  for (const r of filled) {
    if (!r.name) return { ok: false, error: "missing_guest_name" };
    if (!r.email) continue;
    if (!guestInputSchema.shape.email.safeParse(r.email).success || seen.has(r.email)) return { ok: false, error: "invalid_guest_email" };
    seen.add(r.email);
    guests.push({ name: r.name, email: r.email });
  }
  return { ok: true, extraAttendees: filled.map((r) => r.name), guests };
}

export const cancelInputSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{20,200}$/),
});
