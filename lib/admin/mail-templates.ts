/**
 * E-Mail-Vorlagen (Admin → E-Mail-Vorlagen): welche Mailtexte ein Mandant
 * anpassen kann, welche Platzhalter erlaubt sind und wie Anpassungen in
 * tenants.text_overrides landen. Reine Logik (auch im Browser für die Vorschau).
 */
import { TEXTS, textOverridesSchema, type Anrede, type TextKey, type TextOverrides } from "@/lib/texts";

export type MailTemplateGroup = { id: string; keys: TextKey[] };

/** Gruppiert nach Mail; Reihenfolge = Reihenfolge in der Mail */
export const MAIL_TEMPLATE_GROUPS: MailTemplateGroup[] = [
  {
    id: "invitation",
    keys: ["mail.invitation.subject", "mail.greeting", "mail.invitation.text", "mail.invitation.button", "mail.invitation.validity", "mail.regards"],
  },
  {
    id: "confirmation",
    keys: ["mail.confirmation.subject", "mail.confirmation.title", "mail.ics.hint", "mail.contact", "mail.contactFallback", "mail.person", "mail.persons"],
  },
  { id: "changed", keys: ["mail.confirmation.changedSubject", "mail.confirmation.changedTitle", "mail.rescheduled", "mail.guestCancelled"] },
  { id: "cancellation", keys: ["mail.cancellation.subject", "mail.cancellation.title", "mail.cancellation.byOrganizer", "mail.cancellation.text"] },
  {
    id: "guest",
    keys: ["mail.guest.subject", "mail.guest.title", "mail.guest.text", "mail.guest.changedSubject", "mail.guest.changedTitle"],
  },
  { id: "guestCancelled", keys: ["mail.guest.cancelled.subject", "mail.guest.cancelled.title", "mail.guest.cancelled.text"] },
];

export const MAIL_TEMPLATE_KEYS: TextKey[] = MAIL_TEMPLATE_GROUPS.flatMap((g) => g.keys);
const KEY_SET = new Set<string>(MAIL_TEMPLATE_KEYS);

export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))];
}

/** Erlaubte Platzhalter je Schlüssel = die des Standardtexts (beide Anreden) */
export function allowedPlaceholders(key: TextKey): string[] {
  return [...new Set([...placeholdersOf(TEXTS[key].sie), ...placeholdersOf(TEXTS[key].ihr)])];
}

/** Ohne diese Platzhalter fehlt in der Mail etwas Wichtiges (z. B. der Link) */
const REQUIRED: Partial<Record<TextKey, string[]>> = {
  "mail.cancellation.text": ["link"],
};

export type TemplateIssue = { key: TextKey; kind: "unknown_placeholder" | "missing_placeholder" | "too_long"; placeholder?: string };

export function checkTemplate(key: TextKey, value: string): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  if (value.length > 500) issues.push({ key, kind: "too_long" });
  const allowed = allowedPlaceholders(key);
  for (const p of placeholdersOf(value)) if (!allowed.includes(p)) issues.push({ key, kind: "unknown_placeholder", placeholder: p });
  for (const p of REQUIRED[key] ?? []) if (!placeholdersOf(value).includes(p)) issues.push({ key, kind: "missing_placeholder", placeholder: p });
  return issues;
}

export type MergeTemplatesResult = { ok: true; overrides: TextOverrides } | { ok: false; issues: TemplateIssue[] };

/**
 * Formularwerte -> neue text_overrides. Leere Felder und Standardtexte
 * entfernen die Anpassung; andere (Nicht-Mail-)Anpassungen bleiben.
 */
export function mergeMailOverrides(current: TextOverrides, input: Partial<Record<string, string>>, anrede: Anrede): MergeTemplatesResult {
  const next: Record<string, string> = { ...current };
  const issues: TemplateIssue[] = [];
  for (const key of MAIL_TEMPLATE_KEYS) {
    if (!(key in input)) continue;
    const value = (input[key] ?? "").replace(/\r\n/g, "\n").trim();
    if (!value || value === TEXTS[key][anrede]) {
      delete next[key];
      continue;
    }
    issues.push(...checkTemplate(key, value));
    next[key] = value;
  }
  if (issues.length) return { ok: false, issues };
  const parsed = textOverridesSchema.safeParse(next);
  if (!parsed.success) return { ok: false, issues: [] };
  return { ok: true, overrides: parsed.data as TextOverrides };
}

export function isMailTemplateKey(k: string): k is TextKey {
  return KEY_SET.has(k);
}
