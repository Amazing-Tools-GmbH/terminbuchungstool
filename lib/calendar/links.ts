/** "Zum Kalender hinzufügen"-Links für Google und Outlook (Web) */
import { icsDate } from "./ics";

export type CalendarLinkInput = {
  title: string;
  start: Date;
  end: Date;
  location?: string | null;
  details?: string | null;
};

export function googleCalendarUrl(e: CalendarLinkInput): string {
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: e.title,
    dates: `${icsDate(e.start)}/${icsDate(e.end)}`,
  });
  if (e.location) p.set("location", e.location);
  if (e.details) p.set("details", e.details);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

export function outlookCalendarUrl(e: CalendarLinkInput): string {
  const p = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: e.title,
    startdt: e.start.toISOString(),
    enddt: e.end.toISOString(),
  });
  if (e.location) p.set("location", e.location);
  if (e.details) p.set("body", e.details);
  return `https://outlook.office.com/calendar/0/deeplink/compose?${p.toString()}`;
}
