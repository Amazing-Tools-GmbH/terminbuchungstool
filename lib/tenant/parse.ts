import { z } from "zod";
import { parseTheme } from "@/lib/theme/schema";
import { parseTextOverrides } from "@/lib/texts";
import type { LegalLink, PublicTenant } from "./types";

const legalLinkSchema = z.object({
  label: z.string().trim().min(1).max(60),
  href: z.string().url().refine((u) => /^https?:\/\//.test(u), "nur http(s)"),
});

export const legalLinksSchema = z.array(legalLinkSchema).max(10);

function parseLegalLinks(raw: unknown): LegalLink[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((l) => {
    const r = legalLinkSchema.safeParse(l);
    return r.success ? [r.data] : [];
  });
}

/** Wandelt das jsonb aus public.resolve_tenant in ein typisiertes Objekt. */
export function parsePublicTenant(row: Record<string, unknown>, assetUrl: (key: string) => string): PublicTenant {
  return {
    id: String(row.id),
    slug: String(row.slug),
    customDomain: typeof row.custom_domain === "string" && row.custom_domain ? row.custom_domain : null,
    name: String(row.name),
    theme: parseTheme(row.theme),
    anrede: row.anrede === "ihr" ? "ihr" : "sie",
    textOverrides: parseTextOverrides(row.text_overrides),
    legalLinks: parseLegalLinks(row.legal_links),
    claim: typeof row.claim === "string" && row.claim ? row.claim : null,
    contactLine: typeof row.contact_line === "string" && row.contact_line ? row.contact_line : null,
    logoUrl: typeof row.logo_path === "string" && row.logo_path ? assetUrl(row.logo_path) : null,
    changeDeadlineHours: Number(row.change_deadline_hours ?? 48),
    timezone: typeof row.timezone === "string" ? row.timezone : "Europe/Vienna",
  };
}
