/** Entwickler-Werkzeuge (z. B. /dev/mails): nie in Produktion */
export function devToolsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.VERCEL_ENV === "production") return false;
  return env.DEV_TOOLS_ENABLED === "true";
}
