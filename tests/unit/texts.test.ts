import { describe, expect, it } from "vitest";
import { TEXTS, createTranslator, parseTextOverrides, textOverridesSchema } from "@/lib/texts";

describe("Texte je Anrede", () => {
  it("liefert Ihr- bzw. Sie-Variante", () => {
    expect(createTranslator("ihr")("aside.title")).toBe("Eure Buchung");
    expect(createTranslator("sie")("aside.title")).toBe("Ihre Buchung");
  });

  it("ersetzt Platzhalter", () => {
    expect(createTranslator("sie")("slots.free", { free: 3, capacity: 12 })).toBe("3 von 12 Plätzen frei");
  });

  it("Overrides gewinnen; unbekannte/ungültige werden ignoriert", () => {
    const o = parseTextOverrides({ "aside.submit": "Jetzt anmelden", "gibts.nicht": "x", "done.title": 42 });
    expect(o).toEqual({ "aside.submit": "Jetzt anmelden" });
    expect(createTranslator("ihr", o)("aside.submit")).toBe("Jetzt anmelden");
    expect(textOverridesSchema.safeParse({ "gibts.nicht": "x" }).success).toBe(false);
  });

  it("Ihr-Texte enthalten kein 'Sie'/'Ihre' und umgekehrt", () => {
    for (const [key, v] of Object.entries(TEXTS)) {
      // "Ihr" am Satzanfang ist auch in der Ihr-Form korrekt ("Ihr bekommt …")
      expect(v.ihr, key).not.toMatch(/\b(Sie|Ihnen|Ihre[nms]?)\b/);
      expect(v.sie, key).not.toMatch(/\b(ihr|euer|eure[nm]?)\b/);
    }
  });
});
