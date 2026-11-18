/**
 * Baut die lokale Dev-Datenbank komplett neu auf (Shims + Migrationen) und
 * spielt danach den Seed ein. NUR für die Übergangsumgebung ohne Supabase.
 */
import { rm } from "node:fs/promises";
import { requireEnv } from "./env";
import { LOCAL_ASSET_ROOT } from "../lib/storage";
import { resetDatabase } from "../lib/db/migrate";
import { runSeed } from "./seed";

if (process.env.SUPABASE_DB_URL) {
  console.error("SUPABASE_DB_URL ist gesetzt – gegen Supabase bitte `npx supabase db push` verwenden, nicht db:reset.");
  process.exit(1);
}

const url = requireEnv("DATABASE_URL");
// lokale Logo-Ablage mit zurücksetzen (Mandanten bekommen neue IDs)
await rm(LOCAL_ASSET_ROOT, { recursive: true, force: true });
await resetDatabase(url, { log: true });
await runSeed(url);
