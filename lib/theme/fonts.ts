/**
 * Selbst gehostete Google Fonts (next/font lädt sie beim Build herunter und
 * liefert sie von unserer Domain aus – keine Anfragen an Google zur
 * Laufzeit, DSGVO-freundlich).
 *
 * Alle Schriften der Allowlist werden als CSS-Variable registriert; der
 * Browser lädt eine Schriftdatei aber nur, wenn das Mandanten-Theme sie
 * tatsächlich verwendet. Neue Schrift: hier ergänzen + font-names.ts.
 */
import {
  IBM_Plex_Sans,
  Inter,
  Lato,
  Lora,
  Merriweather,
  Montserrat,
  Nunito_Sans,
  Open_Sans,
  Overpass,
  Roboto,
  Source_Sans_3,
  Work_Sans,
} from "next/font/google";

// next/font verlangt literale Optionen je Aufruf (kein Spread)
const overpass = Overpass({ subsets: ["latin", "latin-ext"], display: "swap", preload: false, weight: ["400", "600", "700", "800"], variable: "--font-overpass" });
const inter = Inter({ subsets: ["latin", "latin-ext"], display: "swap", preload: false, weight: ["400", "600", "700", "800"], variable: "--font-inter" });
const roboto = Roboto({ subsets: ["latin", "latin-ext"], display: "swap", preload: false, weight: ["400", "500", "700"], variable: "--font-roboto" });
const openSans = Open_Sans({ subsets: ["latin", "latin-ext"], display: "swap", preload: false, weight: ["400", "600", "700", "800"], variable: "--font-open-sans" });
const lato = Lato({ subsets: ["latin", "latin-ext"], display: "swap", preload: false, weight: ["400", "700", "900"], variable: "--font-lato" });
const montserrat = Montserrat({ subsets: ["latin", "latin-ext"], display: "swap", preload: false, weight: ["400", "600", "700", "800"], variable: "--font-montserrat" });
const sourceSans3 = Source_Sans_3({ subsets: ["latin", "latin-ext"], display: "swap", preload: false, weight: ["400", "600", "700", "800"], variable: "--font-source-sans-3" });
const nunitoSans = Nunito_Sans({ subsets: ["latin", "latin-ext"], display: "swap", preload: false, weight: ["400", "600", "700", "800"], variable: "--font-nunito-sans" });
const workSans = Work_Sans({ subsets: ["latin", "latin-ext"], display: "swap", preload: false, weight: ["400", "600", "700", "800"], variable: "--font-work-sans" });
const ibmPlexSans = IBM_Plex_Sans({ subsets: ["latin", "latin-ext"], display: "swap", preload: false, weight: ["400", "600", "700"], variable: "--font-ibm-plex-sans" });
const merriweather = Merriweather({ subsets: ["latin", "latin-ext"], display: "swap", preload: false, weight: ["400", "700", "900"], variable: "--font-merriweather" });
const lora = Lora({ subsets: ["latin", "latin-ext"], display: "swap", preload: false, weight: ["400", "600", "700"], variable: "--font-lora" });

/** className für <html>, registriert alle Schrift-Variablen */
export const fontVariablesClassName = [
  overpass,
  inter,
  roboto,
  openSans,
  lato,
  montserrat,
  sourceSans3,
  nunitoSans,
  workSans,
  ibmPlexSans,
  merriweather,
  lora,
]
  .map((f) => f.variable)
  .join(" ");
