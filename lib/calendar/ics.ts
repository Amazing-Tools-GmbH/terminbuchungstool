/**
 * iCalendar (.ics, RFC 5545) für eine Buchung. Bewusst ohne Bibliothek:
 * Zeiten in UTC (…Z) – das verstehen Outlook, Google und Apple ohne
 * VTIMEZONE-Block zuverlässig und zeigen sie in der lokalen Zeit an.
 */

export type IcsEvent = {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  location?: string | null;
  description?: string | null;
  url?: string | null;
  organizer?: { name: string; email: string } | null;
  /** STATUS:CANCELLED + METHOD:CANCEL für Stornierungen */
  cancelled?: boolean;
  /** Steigt bei jeder Änderung (Umbuchung) */
  sequence?: number;
  stamp?: Date;
};

export function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Text-Escaping nach RFC 5545 §3.3.11 */
export function icsEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/;/g, "\;").replace(/,/g, "\\,");
}

/** Zeilen auf 75 Oktette falten (RFC 5545 §3.1), UTF-8-sicher */
export function foldLine(line: string): string {
  const bytes = new TextEncoder();
  const out: string[] = [];
  let current = "";
  let len = 0;
  for (const ch of line) {
    const n = bytes.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // Folgezeilen beginnen mit Leerzeichen
    if (len + n > limit) {
      out.push(current);
      current = "";
      len = 0;
    }
    current += ch;
    len += n;
  }
  out.push(current);
  return out.join("\r\n ");
}

export function buildIcs(ev: IcsEvent, prodId = "-//Terminbuchung//DE"): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${prodId}`,
    "CALSCALE:GREGORIAN",
    `METHOD:${ev.cancelled ? "CANCEL" : "PUBLISH"}`,
    "BEGIN:VEVENT",
    `UID:${ev.uid}`,
    `DTSTAMP:${icsDate(ev.stamp ?? new Date())}`,
    `DTSTART:${icsDate(ev.start)}`,
    `DTEND:${icsDate(ev.end)}`,
    `SEQUENCE:${ev.sequence ?? 0}`,
    `SUMMARY:${icsEscape(ev.summary)}`,
    ev.location ? `LOCATION:${icsEscape(ev.location)}` : null,
    ev.description ? `DESCRIPTION:${icsEscape(ev.description)}` : null,
    ev.url ? `URL:${ev.url}` : null,
    ev.organizer ? `ORGANIZER;CN=${icsEscape(ev.organizer.name).replace(/:/g, "")}:mailto:${ev.organizer.email}` : null,
    `STATUS:${ev.cancelled ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter((l): l is string => l !== null);
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
