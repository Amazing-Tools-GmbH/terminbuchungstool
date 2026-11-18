import { buildIcs } from "@/lib/calendar/ics";

export type BookingIcsInput = {
  tenantName: string;
  invitationId: string;
  title: string;
  start: Date;
  end: Date;
  location: string | null;
  url: string | null;
  organizer?: { name: string; email: string } | null;
  /** Zeitpunkt der Version: created_at der Buchung bzw. cancelled_at bei Storno */
  versionAt: Date;
  cancelled?: boolean;
};

/**
 * .ics zu einer Buchung. UID je Einladung -> Kalender ersetzen den Eintrag
 * bei Umbuchung bzw. entfernen ihn bei Storno. SEQUENCE = Sekunden seit
 * Epoch der Version (steigt mit jeder Änderung).
 */
export function bookingIcs(i: BookingIcsInput): string {
  return buildIcs(
    {
      uid: `${i.invitationId}@terminbuchung`,
      sequence: Math.floor(i.versionAt.getTime() / 1000),
      start: i.start,
      end: i.end,
      summary: `${i.title} – ${i.tenantName}`,
      location: i.location,
      description: i.url,
      url: i.url,
      organizer: i.organizer ?? null,
      cancelled: i.cancelled,
    },
    `-//${i.tenantName.replace(/[^\p{L}\p{N} .-]/gu, "")}//Terminbuchung//DE`,
  );
}
