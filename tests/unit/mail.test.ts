import { describe, expect, it, vi } from "vitest";
import { escapeHtml, renderConfirmation, renderCancellation, renderInvitation, type MailTenant } from "@/lib/mail/templates";
import { SmtpMailSender, classifySmtpError } from "@/lib/mail/senders/smtp";
import { parseTheme } from "@/lib/theme/schema";
import { SEED_TENANTS } from "@/seed/tenants";

function tenant(slug: string, overrides = {}): MailTenant {
  const s = SEED_TENANTS.find((t) => t.slug === slug)!;
  return {
    name: s.name,
    theme: parseTheme(s.theme),
    anrede: s.anrede,
    textOverrides: overrides,
    contactLine: s.contactLine,
    legalLinks: s.legalLinks,
    timezone: "Europe/Vienna",
    changeDeadlineHours: 48,
    logoUrl: null,
  };
}

const data = {
  eventTitle: "Kunden-Workshop Radiowerbung",
  startsAt: new Date("2026-12-09T09:00:00Z"),
  endsAt: new Date("2026-12-09T11:00:00Z"),
  location: "Studio <A&B>",
  seats: 3,
  name: "Maria <script>alert(1)</script> Muster",
  extraAttendees: ["Max Beispiel"],
  bookingUrl: "https://example.at/b/tok?x=1&y=2",
  icsFilename: "termin.ics",
  changed: false,
};

describe("Mail-Vorlagen", () => {
  it("Bestätigung (Sie): Betreff, Inhalte, Ansprechpartner statt Änderungslink, Theme-Farben", () => {
    const m = renderConfirmation(tenant("demo"), { ...data, contactName: "Markus Fink" });
    expect(m.subject).toBe("Buchungsbestätigung: Kunden-Workshop Radiowerbung am 09.12.2026");
    expect(m.html).toContain("Ihre Buchung ist bestätigt");
    expect(m.html).toContain("Mi, 09.12.2026");
    expect(m.html).toContain("10:00–12:00");
    expect(m.html).toContain("3 Personen");
    // kein Umbuchen/Stornieren über einen Link
    expect(m.html).not.toContain("https://example.at/b/tok");
    expect(m.text).not.toContain("https://example.at/b/tok");
    expect(m.html).toContain("Sie können nicht kommen oder müssen etwas ändern? Bitte wenden Sie sich an Markus Fink");
    expect(m.html).toContain("#1F4FB4");
  });

  it("Bestätigung (Ihr) im ANTENNE-Theme", () => {
    const m = renderConfirmation(tenant("antennevorarlberg"), { ...data, seats: 1, changed: true });
    expect(m.subject).toMatch(/^Geänderte Buchung/);
    expect(m.html).toContain("Eure Buchung wurde geändert");
    // ohne bekannten Ansprechpartner: Antwort auf die Mail
    expect(m.html).toContain("Ihr könnt nicht kommen oder müsst etwas ändern? Bitte meldet euch per Antwort auf diese E-Mail.");
    expect(m.html).toContain("1 Person");
    expect(m.html).toContain("#FFE500");
    expect(m.html).toContain("Fragen? Ruft uns an");
  });

  it("escaped alle Benutzereingaben", () => {
    const m = renderConfirmation(tenant("demo"), data);
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.html).toContain("Studio &lt;A&amp;B&gt;");
    expect(escapeHtml(`"'`)).toBe("&quot;&#39;");
  });

  it("Text-Overrides des Mandanten greifen auch in Mails", () => {
    const m = renderConfirmation(tenant("demo", { "mail.confirmation.title": "Alles klar!" }), data);
    expect(m.html).toContain("Alles klar!");
  });

  it("Storno und Einladung", () => {
    const c = renderCancellation(tenant("demo"), data);
    expect(c.subject).toBe("Stornierung: Kunden-Workshop Radiowerbung am 09.12.2026");
    expect(c.html).toContain("Ihre Buchung wurde storniert");
    const i = renderInvitation(tenant("antennevorarlberg"), {
      eventTitle: "Kunden-Workshop Radiowerbung",
      name: "Maria Muster",
      bookingUrl: "https://example.at/b/tok",
      validDays: 30,
      senderName: "Stephan Steinbach",
    });
    expect(i.subject).toBe("Euer Termin bei ANTENNE VORARLBERG – bitte wählt euer Datum");
    expect(i.html).toContain("Termin auswählen");
    expect(i.html).toContain("30 Tage gültig");
  });
});

describe("SMTP", () => {
  it("übergibt Absender, Empfänger, Reply-To und Anhang an den Transport", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "<abc@x>" });
    const sender = new SmtpMailSender({ host: "h", port: 587, secure: false, user: "u", pass: "p" }, { sendMail });
    const r = await sender.send({
      from: { email: "termine@firma.at", name: "Firma" },
      to: { email: "kunde@x.at", name: "Kunde" },
      replyTo: { email: "office@firma.at" },
      subject: "S",
      html: "<p>h</p>",
      text: "t",
      attachments: [{ filename: "a.ics", contentType: "text/calendar", content: "BEGIN" }],
    });
    expect(r.messageId).toBe("<abc@x>");
    const arg = sendMail.mock.calls[0]![0];
    expect(arg.from).toEqual({ address: "termine@firma.at", name: "Firma" });
    expect(arg.replyTo).toEqual({ address: "office@firma.at", name: "" });
    expect(arg.attachments[0].filename).toBe("a.ics");
  });

  it("klassifiziert Fehler", () => {
    expect(classifySmtpError({ code: "EAUTH", responseCode: 535, message: "bad" }).kind).toBe("auth");
    expect(classifySmtpError({ responseCode: 550, message: "no such user" }).kind).toBe("permanent");
    expect(classifySmtpError({ responseCode: 421, message: "try later" }).kind).toBe("transient");
    expect(classifySmtpError({ code: "ECONNRESET", message: "reset" }).kind).toBe("transient");
  });
});
