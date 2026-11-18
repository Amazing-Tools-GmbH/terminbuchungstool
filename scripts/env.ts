/** Lädt .env.local / .env für Node-Skripte (Next.js macht das selbst). */
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

for (const f of [".env.local", ".env"]) {
  if (existsSync(f)) loadEnvFile(f);
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Umgebungsvariable ${name} fehlt (siehe .env.example)`);
  return v;
}
