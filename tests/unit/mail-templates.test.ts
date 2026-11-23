/** E-Mail-Vorlagen: Platzhalter-Prüfung und Speichern in text_overrides */
import { describe, expect, it } from "vitest";
import { MAIL_TEMPLATE_KEYS, allowedPlaceholders, checkTemplate, mergeMailOverrides } from "@/lib/admin/mail-templates";
import { TEXTS, createTranslator } from "@/lib/texts";
import { renderConfirmation } from "@/lib/mail/templates";
import { parseTheme } from "@/lib/theme/schema";

describe("Vorlagen", () => {
  it("alle Schlüssel sind Mailtexte", () => {
    for (const k of MAIL_TEMPLATE_KEYS) expect(k.startsWith("mail.")).toBe(true);
    expect(new Set(MAIL_TEMPLATE_KEYS).size).toBe(MAIL_TEMPLATE_KEYS.length);
  });

  it("erlaubte Platzhalter kommen aus dem Standardtext", () => {
    expect(allowedPlaceholders("mail.confirmation.subject").sort()).toEqual(["date", "event"]);
    expect(checkTemplate("mail.confirmation.subject", "Gebucht: {event} am {date}")).toEqual([]);
    expect(checkTemplate("mail.confirmation.subject", "Hallo {vorname}")).toEqual([
      { key: "mail.confirmation.subject", kind: "unknown_placeholder", placeholder: "vorname" },
    ]);
    // ohne {link} fehlt der Link zum Ändern
    expect(checkTemplate("mail.change", "Ändern bis {hours} Stunden vorher.")).toEqual([
      { key: "mail.change", kind: "missing_placeholder", placeholder: "link" },
    ]);
  });

  it("Speichern: Standard/leer entfernt die Anpassung, andere Texte bleiben", () => {
    const current = { "hero.intro": "Eigener Text", "mail.regards": "Alt" } as const;
    const r = mergeMailOverrides(current, { "mail.regards": "", "mail.confirmation.title": TEXTS["mail.confirmation.title"].sie, "mail.greeting": "Servus {name}," }, "sie");
    expect(r).toEqual({ ok: true, overrides: { "hero.intro": "Eigener Text", "mail.greeting": "Servus {name}," } });
    expect(mergeMailOverrides({}, { "mail.greeting": "Hi {x}" }, "sie").ok).toBe(false);
    // unbekannte Schlüssel werden ignoriert
    expect(mergeMailOverrides({}, { "hero.intro": "x" }, "sie")).toEqual({ ok: true, overrides: {} });
  });

  it("Anpassung erscheint in der gerenderten Mail", () => {
    const tr = createTranslator("sie", { "mail.confirmation.title": "Super, Sie sind dabei!" });
    expect(tr("mail.confirmation.title")).toBe("Super, Sie sind dabei!");
    const m = renderConfirmation(
      {
        name: "Firma",
        theme: parseTheme({}),
        anrede: "sie",
        textOverrides: { "mail.confirmation.title": "Super, Sie sind dabei!" },
        contactLine: null,
        legalLinks: [],
        timezone: "Europe/Vienna",
        changeDeadlineHours: 48,
        logoUrl: null,
      },
      { eventTitle: "E", startsAt: new Date(), endsAt: new Date(), location: null, seats: 1, name: "M", extraAttendees: [], bookingUrl: null, icsFilename: "t.ics", changed: false },
    );
    expect(m.html).toContain("Super, Sie sind dabei!");
  });
});
