import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

for (const f of [".env.local", ".env"]) {
  if (existsSync(f)) loadEnvFile(f);
}
