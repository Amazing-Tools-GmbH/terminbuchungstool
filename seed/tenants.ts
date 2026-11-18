/**
 * Seed-Daten der Mandanten. Hier – und NUR hier bzw. in der Datenbank –
 * steht Kundenspezifisches. Der App-Code kennt keinen Mandanten beim Namen.
 * Theme-Werte: docs/claude-code-prompt.md + docs/mockup/3-buchungsseite.dc.html
 */
import type { Anrede } from "@/lib/texts";
import type { LegalLink } from "@/lib/tenant/types";

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
  admin: { email: string };
  event: { title: string; location: string; description: string | null; slots: SeedSlot[] };
  invitation: { name: string; email: string; pipedriveDealId: number };
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
    admin: { email: "admin@antenne-vorarlberg.example" },
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
    invitation: { name: "Maria Muster", email: "maria.muster@muster-autohaus.example", pipedriveDealId: 1001 },
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
    admin: { email: "admin@demo.example" },
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
    invitation: { name: "Max Beispiel", email: "max.beispiel@kunde.example", pipedriveDealId: 2001 },
  },
];
