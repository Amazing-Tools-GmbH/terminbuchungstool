/** Datums-/Zeitformatierung in der Zeitzone des Mandanten (Standard Europe/Vienna) */

export type DateParts = { weekday: string; weekdayShort: string; date: string; time: string };

function fmt(tz: string, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("de-AT", { timeZone: tz, ...opts });
}

/** "Dienstag", "Di", "01.12.2026", "09:00–11:00" */
export function formatSlot(startsAt: Date | string, endsAt: Date | string, tz: string): DateParts {
  const s = new Date(startsAt);
  const e = new Date(endsAt);
  const time = fmt(tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const sameDay = formatDate(s, tz) === formatDate(e, tz);
  return {
    weekday: fmt(tz, { weekday: "long" }).format(s),
    weekdayShort: fmt(tz, { weekday: "short" }).format(s).replace(/\.$/, ""),
    date: formatDate(s, tz),
    time: sameDay ? `${time.format(s)}–${time.format(e)}` : `${time.format(s)}–${formatDate(e, tz)} ${time.format(e)}`,
  };
}

export function formatDate(d: Date | string, tz: string): string {
  return fmt(tz, { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(d));
}

export function formatDateTime(d: Date | string, tz: string): string {
  const date = new Date(d);
  return `${formatDate(date, tz)}, ${fmt(tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date)} Uhr`;
}
