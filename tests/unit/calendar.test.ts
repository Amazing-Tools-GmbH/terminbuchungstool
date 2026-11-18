import { describe, expect, it } from "vitest";
import { buildIcs, foldLine, icsEscape } from "@/lib/calendar/ics";
import { googleCalendarUrl, outlookCalendarUrl } from "@/lib/calendar/links";
import { bookingIcs } from "@/lib/booking/ics";
import { formatSlot } from "@/lib/datetime";

const start = new Date("2026-12-09T09:00:00Z"); // 10:00 Wien
const end = new Date("2026-12-09T11:00:00Z");

describe("ics", () => {
  it("erzeugt gültiges VEVENT mit UTC-Zeiten und CRLF", () => {
    const ics = buildIcs({ uid: "x@y", start, end, summary: "Workshop; Teil 1, Radio", location: "Studio\nDornbirn", stamp: start });
    expect(ics).toContain("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n");
    expect(ics).toContain("DTSTART:20261209T090000Z\r\n");
    expect(ics).toContain("DTEND:20261209T110000Z\r\n");
    expect(ics).toContain("SUMMARY:Workshop\; Teil 1\\, Radio");
    expect(ics).toContain("LOCATION:Studio\\nDornbirn");
    expect(ics).toContain("STATUS:CONFIRMED");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("faltet lange Zeilen auf max. 75 Byte, auch mit Umlauten", () => {
    const folded = foldLine("SUMMARY:" + "Ä".repeat(100));
    for (const line of folded.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe("SUMMARY:" + "Ä".repeat(100));
  });

  it("Storno: METHOD:CANCEL, STATUS:CANCELLED, gleiche UID je Einladung, höhere SEQUENCE", () => {
    const base = { tenantName: "Firma", invitationId: "inv-1", title: "WS", start, end, location: null, url: null };
    const booked = bookingIcs({ ...base, versionAt: new Date("2026-11-18T10:00:00Z") });
    const cancelled = bookingIcs({ ...base, versionAt: new Date("2026-11-19T10:00:00Z"), cancelled: true });
    expect(booked).toContain("UID:inv-1@terminbuchung");
    expect(cancelled).toContain("UID:inv-1@terminbuchung");
    expect(cancelled).toContain("METHOD:CANCEL");
    expect(cancelled).toContain("STATUS:CANCELLED");
    const seq = (s: string) => Number(/SEQUENCE:(\d+)/.exec(s)![1]);
    expect(seq(cancelled)).toBeGreaterThan(seq(booked));
    expect(icsEscape("a\\b")).toBe("a\\\\b");
  });
});

describe("Kalenderlinks", () => {
  it("Google", () => {
    const u = new URL(googleCalendarUrl({ title: "WS & Co", start, end, location: "Studio" }));
    expect(u.searchParams.get("dates")).toBe("20261209T090000Z/20261209T110000Z");
    expect(u.searchParams.get("text")).toBe("WS & Co");
    expect(u.searchParams.get("location")).toBe("Studio");
  });
  it("Outlook", () => {
    const u = new URL(outlookCalendarUrl({ title: "WS", start, end }));
    expect(u.hostname).toBe("outlook.office.com");
    expect(u.searchParams.get("startdt")).toBe(start.toISOString());
  });
});

describe("Datum in Mandanten-Zeitzone", () => {
  it("formatiert Europe/Vienna", () => {
    expect(formatSlot(start, end, "Europe/Vienna")).toEqual({
      weekday: "Mittwoch",
      weekdayShort: "Mi",
      date: "09.12.2026",
      time: "10:00–12:00",
    });
  });
  it("Sommerzeit", () => {
    const s = new Date("2027-06-01T07:00:00Z");
    expect(formatSlot(s, new Date("2027-06-01T08:30:00Z"), "Europe/Vienna").time).toBe("09:00–10:30");
  });
});
