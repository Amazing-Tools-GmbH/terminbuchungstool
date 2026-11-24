import type { NextConfig } from "next";

// Die App läuft im Root ihrer Adresse (produktiv https://meetings.atools.de), ohne basePath.
// Ein Unterpfad in APP_BASE_URL wäre ein Konfigurationsfehler -> Build bricht ab.
const appBase = process.env.APP_BASE_URL;
if (appBase) {
  let path = "/";
  try {
    path = new URL(appBase).pathname;
  } catch {
    throw new Error(`APP_BASE_URL ist keine gültige URL: ${appBase}`);
  }
  if (path !== "/" && path !== "") throw new Error(`APP_BASE_URL darf keinen Pfad enthalten (die App läuft im Root): ${appBase}`);
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // pg ist ein Node-Modul und soll nicht gebündelt werden
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  // Logo-Upload im Admin (max. 1 MB Datei + Formular-Overhead)
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
  // Schlanke Laufzeit-Ausgabe (.next/standalone mit server.js und nur den nötigen Paketen):
  // wird von GitHub Actions gebaut und als Release auf den Server kopiert.
  output: "standalone",
  async headers() {
    return [
      // Das Vertriebs-Panel läuft als iframe in Pipedrive – nur dort (und lokal auf der Dev-Seite) einbettbar
      { source: "/panel", headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'self' https://*.pipedrive.com" }] },
      // App-Einstellungen in Pipedrive (Custom UI) – ebenfalls nur dort einbettbar
      { source: "/app-settings", headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'self' https://*.pipedrive.com" }] },
      // alles andere nie einbetten (Clickjacking)
      { source: "/((?!panel$|app-settings$).*)", headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }] },
    ];
  },
};

export default nextConfig;
