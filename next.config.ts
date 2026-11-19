import type { NextConfig } from "next";
import { basePathFrom } from "./lib/base-path";

// Unterpfad aus APP_BASE_URL (z. B. https://atools.de/meetings -> /meetings).
// Gilt ab dem Build; nach Änderung von APP_BASE_URL neu bauen.
const basePath = basePathFrom({ APP_BASE_URL: process.env.APP_BASE_URL });

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // pg ist ein Node-Modul und soll nicht gebündelt werden
  serverExternalPackages: ["pg"],
  ...(basePath ? { basePath } : {}),
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  async headers() {
    return [
      // Das Vertriebs-Panel läuft als iframe in Pipedrive – nur dort (und lokal auf der Dev-Seite) einbettbar
      { source: "/panel", headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'self' https://*.pipedrive.com" }] },
      // alles andere nie einbetten (Clickjacking)
      { source: "/((?!panel$).*)", headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }] },
    ];
  },
};

export default nextConfig;
