import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

for (const f of [".env.local", ".env"]) {
  if (existsSync(f)) loadEnvFile(f);
}

// Tests nutzen immer die lokale Asset-Ablage – unabhängig von der Umgebung.
process.env.ASSET_STORAGE = "local";
