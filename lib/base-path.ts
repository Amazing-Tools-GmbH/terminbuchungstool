/**
 * Unterpfad der App (Next.js basePath), abgeleitet aus APP_BASE_URL:
 *   APP_BASE_URL=https://atools.de/meetings  ->  "/meetings"
 *   APP_BASE_URL=http://localhost:3000       ->  ""
 * next.config.ts setzt basePath zur BUILD-Zeit und reicht den Wert als
 * NEXT_PUBLIC_BASE_PATH an Server- und Browser-Code weiter (Änderung =>
 * neu bauen).
 *
 * Next.js ergänzt den Unterpfad selbst bei <Link>, redirect(), revalidatePath
 * und Server Actions – NICHT bei einfachen href/action-Attributen, fetch() im
 * Browser, selbst gebauten Redirect-URLs, Cookie-Pfaden und Links in Mails.
 * Dafür gibt es withBasePath().
 */
type Env = Record<string, string | undefined>;

export function normalizeBasePath(path: string | null | undefined): string {
  const p = (path ?? "").trim().replace(/\/+$/, "");
  if (!p || p === "/") return "";
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(p)) throw new Error(`Ungültiger Unterpfad: ${p}`);
  return p;
}

/** Unterpfad aus der Umgebung (NEXT_PUBLIC_BASE_PATH hat Vorrang, sonst Pfad von APP_BASE_URL) */
export function basePathFrom(env: Env): string {
  if (env.NEXT_PUBLIC_BASE_PATH !== undefined) return normalizeBasePath(env.NEXT_PUBLIC_BASE_PATH);
  if (!env.APP_BASE_URL) return "";
  try {
    return normalizeBasePath(new URL(env.APP_BASE_URL).pathname);
  } catch {
    return "";
  }
}

// Wörtlicher Zugriff, damit Next.js den Wert in den Browser-Code einsetzt
export const BASE_PATH = basePathFrom({ NEXT_PUBLIC_BASE_PATH: process.env.NEXT_PUBLIC_BASE_PATH, APP_BASE_URL: process.env.APP_BASE_URL });

/** "/api/bookings" -> "/meetings/api/bookings" */
export function withBasePath(path: string, basePath: string = BASE_PATH): string {
  if (!path.startsWith("/")) throw new Error(`Pfad muss mit / beginnen: ${path}`);
  return `${basePath}${path}`;
}

/** Pfad für Cookies: auf den Unterpfad beschränkt ("/" ohne Unterpfad) */
export function cookiePath(path = "", basePath: string = BASE_PATH): string {
  return `${basePath}${path}` || "/";
}
