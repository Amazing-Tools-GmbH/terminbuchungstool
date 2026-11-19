/**
 * Adressen der zentralen App (Admin-Backend, Login, OAuth-Callbacks):
 * immer unter APP_BASE_URL (z. B. https://meetings.atools.de).
 */
import { appBaseUrl } from "@/lib/links";

type Env = Record<string, string | undefined>;

/** Absolute URL eines Pfads der App, z. B. appUrl("/admin/login", { error: "x" }) */
export function appUrl(path: string, params: Record<string, string> = {}, env: Env = process.env): string {
  const url = new URL(`${appBaseUrl(env)}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/** Origin (Schema + Host) der App */
export function appOrigin(env: Env = process.env): string {
  return new URL(appBaseUrl(env)).origin;
}
