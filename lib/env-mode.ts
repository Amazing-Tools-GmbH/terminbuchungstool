/**
 * Betriebsart der Installation. APP_ENV=production (Hetzner, meetings.atools.de) |
 * staging | development. Ohne APP_ENV gilt ein Produktions-Build (NODE_ENV=production,
 * also jedes "next start") als Produktion – sicherer Standard.
 * In Produktion sind Entwickler-Werkzeuge (Dev-Login, /dev/*) und ?tenant= immer aus.
 */
type Env = Record<string, string | undefined>;

export function isProduction(env: Env = process.env): boolean {
  const mode = env.APP_ENV?.trim();
  if (mode) return mode === "production";
  return env.NODE_ENV === "production";
}
