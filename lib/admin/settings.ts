import "server-only";
/**
 * Firmendaten & Rechtliches (Admin → Einstellungen, owner/admin): Name,
 * Absender, Antwortadresse, Anrede, Kontaktzeile, Rechtslinks, Frist für
 * Änderungen. Schreibrechte per RLS (tenants_update: owner/admin).
 */
import { z } from "zod";
import { withActor } from "@/lib/db";
import { legalLinksSchema } from "@/lib/tenant/parse";
import type { AdminContext } from "@/lib/auth/admin";
import { AdminError, toAdminError } from "./errors";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v));

export const LEGAL_LINK_ROWS = 5;

export const settingsSchema = z.object({
  name: z.string().trim().min(1).max(200),
  senderName: optionalText(200),
  replyTo: z
    .string()
    .trim()
    .toLowerCase()
    .max(320)
    .transform((v) => (v === "" ? null : v))
    .refine((v) => v === null || z.string().email().safeParse(v).success, "E-Mail-Adresse"),
  anrede: z.enum(["sie", "ihr"]),
  contactLine: optionalText(200),
  changeDeadlineHours: z.coerce.number().int().min(0).max(720),
  legalLinks: legalLinksSchema,
});
export type SettingsInput = z.infer<typeof settingsSchema>;

/** Formularzeilen -> Rechtslinks (Zeilen ohne Adresse fallen weg, auch vorgeschlagene Bezeichnungen) */
export function legalLinksFromForm(form: FormData): { label: string; href: string }[] {
  const out: { label: string; href: string }[] = [];
  for (let i = 0; i < LEGAL_LINK_ROWS; i++) {
    const label = String(form.get(`legalLabel${i}`) ?? "").trim();
    const href = String(form.get(`legalHref${i}`) ?? "").trim();
    if (href) out.push({ label, href });
  }
  return out;
}

export type TenantSettings = SettingsInput;

export async function loadSettings(ctx: AdminContext): Promise<TenantSettings> {
  return withActor(ctx.actor, async (db) => {
    const { rows } = await db.query<{
      name: string;
      sender_name: string | null;
      reply_to_email: string | null;
      anrede: "sie" | "ihr";
      contact_line: string | null;
      change_deadline_hours: number;
      legal_links: { label: string; href: string }[];
    }>(
      "select name, sender_name, reply_to_email, anrede::text as anrede, contact_line, change_deadline_hours, legal_links from public.tenants where id = $1",
      [ctx.tenant.id],
    );
    const r = rows[0];
    if (!r) throw new AdminError("forbidden");
    return {
      name: r.name,
      senderName: r.sender_name,
      replyTo: r.reply_to_email,
      anrede: r.anrede,
      contactLine: r.contact_line,
      changeDeadlineHours: r.change_deadline_hours,
      legalLinks: Array.isArray(r.legal_links) ? r.legal_links : [],
    };
  });
}

export async function saveSettings(ctx: AdminContext, s: SettingsInput): Promise<void> {
  if (ctx.role === "sales") throw new AdminError("forbidden");
  try {
    await withActor(ctx.actor, async (db) => {
      const res = await db.query(
        `update public.tenants
            set name = $2, sender_name = $3, reply_to_email = $4, anrede = $5::public.anrede, contact_line = $6,
                change_deadline_hours = $7, legal_links = $8::jsonb
          where id = $1`,
        [ctx.tenant.id, s.name, s.senderName, s.replyTo, s.anrede, s.contactLine, s.changeDeadlineHours, JSON.stringify(s.legalLinks)],
      );
      if (res.rowCount === 0) throw new AdminError("forbidden");
    });
  } catch (err) {
    throw toAdminError(err);
  }
}

/** Fehlen Impressum oder Datenschutz? (Hinweis im Formular) */
export function missingLegal(links: { label: string }[]): ("impressum" | "datenschutz")[] {
  const l = links.map((x) => x.label.toLowerCase());
  return [
    ...(l.some((x) => x.includes("impressum") || x.includes("imprint")) ? [] : (["impressum"] as const)),
    ...(l.some((x) => x.includes("datenschutz") || x.includes("privacy")) ? [] : (["datenschutz"] as const)),
  ];
}
