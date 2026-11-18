import type { Theme } from "@/lib/theme/schema";
import type { Anrede, TextOverrides } from "@/lib/texts";

export type LegalLink = { label: string; href: string };

/** Öffentliche Mandantendaten (Ergebnis von public.resolve_tenant) */
export type PublicTenant = {
  id: string;
  slug: string;
  name: string;
  theme: Theme;
  anrede: Anrede;
  textOverrides: TextOverrides;
  legalLinks: LegalLink[];
  claim: string | null;
  contactLine: string | null;
  logoUrl: string | null;
  changeDeadlineHours: number;
  timezone: string;
};
