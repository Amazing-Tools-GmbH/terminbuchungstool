/**
 * Seed-Daten der Mandanten. Hier – und NUR hier bzw. in der Datenbank –
 * steht Kundenspezifisches. Der App-Code kennt keinen Mandanten beim Namen.
 * Theme-Werte: docs/claude-code-prompt.md + docs/mockup/3-buchungsseite.dc.html
 */
import type { Anrede } from "@/lib/texts";
import type { LegalLink } from "@/lib/tenant/types";

/**
 * Benutzer der Pipedrive-Firma des Mandanten. Ersetzt lokal die Pipedrive-API
 * (PIPEDRIVE_DIRECTORY=fake), bis die OAuth-App existiert. `access` = im Seed
 * bereits freigeschaltet (Mitglied mit dieser Rolle), sonst kein Zugriff.
 */
export type SeedPipedriveUser = {
  id: number;
  name: string;
  email: string;
  isAdmin: boolean;
  active: boolean;
  access?: "owner" | "admin" | "sales";
};

export type SeedSlot = {
  /** Tage ab heute */
  inDays: number;
  /** Lokalzeit Europe/Vienna, "HH:MM" */
  from: string;
  to: string;
  capacity: number;
  /** bereits belegte Plätze */
  booked: number;
};

/** Beispiel-Deal für das Dev-Panel (PIPEDRIVE_DIRECTORY=fake) */
export type SeedDeal = { id: number; title: string; person: { id: number; name: string; email: string } | null; org: string | null };

export type SeedTenant = {
  slug: string;
  name: string;
  anrede: Anrede;
  claim: string | null;
  contactLine: string | null;
  legalLinks: LegalLink[];
  /** Pfad relativ zum Repo, null = Name als Text im Header */
  logoFile: string | null;
  theme: Record<string, string>;
  senderEmail: string;
  /** Pipedrive-Firma (fiktiv) und ihre Benutzer; genau einer hat access = "owner" */
  pipedrive: { companyId: number; users: SeedPipedriveUser[]; deals?: SeedDeal[] };
  event: { title: string; location: string; description: string | null; slots: SeedSlot[] };
  invitation: { name: string; organization: string; email: string; pipedriveDealId: number };
};

export const SEED_TENANTS: SeedTenant[] = [
  {
    slug: "antennevorarlberg",
    name: "ANTENNE VORARLBERG",
    anrede: "ihr",
    claim: "Mehr Musik! Mehr Vielfalt!",
    contactLine: "Fragen? Ruft uns an: 0800 10 36 36",
    legalLinks: [
      { label: "Impressum", href: "https://www.antennevorarlberg.at/info/impressum/" },
      { label: "AGB", href: "https://www.antennevorarlberg.at/info/agb/" },
      { label: "Datenschutz", href: "https://www.antennevorarlberg.at/info/datenschutz/" },
    ],
    logoFile: "seed/assets/logo-antenne-vorarlberg.svg",
    theme: {
      fontBody: "Overpass",
      fontDisplay: "Overpass",
      primary: "#111111",
      onPrimary: "#FFE500",
      link: "#111111",
      // exakt die Hintergrundfarbe des Logos -> nahtloser Übergang
      headerBg: "#FFE500",
      headerInk: "#111111",
      headerLine: "#FFE500",
      heroBg: "linear-gradient(100deg, #FFE500 0%, #FFE500 30%, #FFC70F 52%, #FD8F22 74%, #F96A2D 100%)",
      heroInk: "#111111",
      heroSub: "#111111",
      accentStrip: "linear-gradient(90deg, #FFE500 0%, #FFC70F 40%, #FD8F22 70%, #F96A2D 100%)",
      bg: "#F6F5F1",
      surface: "#FFFFFF",
      ink: "#111111",
      muted: "#4F5158",
      line: "#E4E2DC",
      field: "#9C9EA4",
      dayColor: "#A63D0A",
      selectedBg: "#FFF7BF",
      selectedLine: "#E8D24A",
      footerBg: "#111111",
      footerInk: "#F1F1F1",
      radius: "6px",
      radiusSm: "4px",
    },
    senderEmail: "termine@antenne-vorarlberg.example",
    pipedrive: {
      companyId: 7100001,
      users: [
        { id: 7200001, name: "Sabine Leitner", email: "admin@antenne-vorarlberg.example", isAdmin: true, active: true, access: "owner" },
        { id: 7200002, name: "Markus Fink", email: "markus.fink@antenne-vorarlberg.example", isAdmin: false, active: true, access: "sales" },
        { id: 7200003, name: "Julia Bechter", email: "julia.bechter@antenne-vorarlberg.example", isAdmin: true, active: true },
        { id: 7200004, name: "Thomas Moosbrugger", email: "thomas.moosbrugger@antenne-vorarlberg.example", isAdmin: false, active: true },
        { id: 7200005, name: "Ehemaliger Mitarbeiter", email: "ehemalig@antenne-vorarlberg.example", isAdmin: false, active: false },
      ],
      deals: [
        { id: 1001, title: "Muster Autohaus GmbH – Frühjahrskampagne 2027", person: { id: 5001, name: "Maria Muster", email: "maria.muster@muster-autohaus.example" }, org: "Muster Autohaus GmbH" },
        { id: 1002, title: "Café Probe – Weihnachtsspot", person: { id: 5002, name: "Anna Probe", email: "anna.probe@cafe-probe.example" }, org: "Café Probe" },
        { id: 1003, title: "Ohne Kontakt – Rahmenvertrag", person: null, org: null },
      ],
    },
    event: {
      title: "Kunden-Workshop Radiowerbung",
      location: "Studio ANTENNE VORARLBERG",
      description: null,
      // ein Termin fast voll, einer ausgebucht (wie im Mock-up)
      slots: [
        { inDays: 13, from: "09:00", to: "11:00", capacity: 12, booked: 11 },
        { inDays: 15, from: "14:00", to: "16:00", capacity: 12, booked: 12 },
        { inDays: 21, from: "10:00", to: "12:00", capacity: 10, booked: 4 },
        { inDays: 27, from: "16:00", to: "18:00", capacity: 15, booked: 2 },
        { inDays: 57, from: "09:00", to: "11:00", capacity: 12, booked: 0 },
      ],
    },
    invitation: { name: "Maria Muster", organization: "Muster Autohaus GmbH", email: "maria.muster@muster-autohaus.example", pipedriveDealId: 1001 },
  },
  {
    slug: "demo",
    name: "Demo GmbH",
    anrede: "sie",
    claim: "Terminbuchung",
    contactLine: "Fragen? Antworten Sie einfach auf Ihre Einladungs-E-Mail.",
    legalLinks: [
      { label: "Impressum", href: "https://example.com/impressum" },
      { label: "Datenschutz", href: "https://example.com/datenschutz" },
    ],
    logoFile: null,
    // neutrales Theme ("Standard (White-Label)" im Mock-up)
    theme: {
      fontBody: "Inter",
      fontDisplay: "Inter",
      primary: "#1F4FB4",
      onPrimary: "#FFFFFF",
      link: "#1F4FB4",
      headerBg: "#FFFFFF",
      headerInk: "#1B1F24",
      headerLine: "#E3E6EA",
      heroBg: "#FFFFFF",
      heroInk: "#1B1F24",
      heroSub: "#5B6470",
      accentStrip: "#1F4FB4",
      bg: "#F6F7F9",
      surface: "#FFFFFF",
      ink: "#1B1F24",
      muted: "#5B6470",
      line: "#E3E6EA",
      field: "#8A929C",
      dayColor: "#1F4FB4",
      selectedBg: "#EEF3FC",
      selectedLine: "#BFD0F0",
      footerBg: "#FFFFFF",
      footerInk: "#3D4550",
      radius: "12px",
      radiusSm: "8px",
    },
    senderEmail: "termine@demo.example",
    pipedrive: {
      companyId: 7100002,
      users: [
        { id: 7300001, name: "Dora Demo", email: "admin@demo.example", isAdmin: true, active: true, access: "owner" },
        { id: 7300002, name: "Victor Vertrieb", email: "vertrieb@demo.example", isAdmin: false, active: true },
      ],
      deals: [{ id: 2001, title: "Beispiel AG – Produktvorstellung", person: { id: 6001, name: "Max Beispiel", email: "max.beispiel@kunde.example" }, org: "Beispiel AG" }],
    },
    event: {
      title: "Produktvorstellung 2027",
      location: "Showroom Demo GmbH",
      description: null,
      slots: [
        { inDays: 10, from: "10:00", to: "11:30", capacity: 8, booked: 3 },
        { inDays: 17, from: "14:00", to: "15:30", capacity: 8, booked: 8 },
        { inDays: 24, from: "10:00", to: "11:30", capacity: 8, booked: 0 },
      ],
    },
    invitation: { name: "Max Beispiel", organization: "Beispiel AG", email: "max.beispiel@kunde.example", pipedriveDealId: 2001 },
  },
];
