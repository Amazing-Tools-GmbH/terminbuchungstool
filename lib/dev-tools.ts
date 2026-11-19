import { isProduction } from "./env-mode";

/** Entwickler-Werkzeuge (Dev-Login, /dev/mails, /dev/panel): nie in Produktion */
export function devToolsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (isProduction(env)) return false;
  return env.DEV_TOOLS_ENABLED === "true";
}
