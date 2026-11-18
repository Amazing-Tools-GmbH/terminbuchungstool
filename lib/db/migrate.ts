/**
 * Lokaler Migrations-Runner für die Übergangsumgebung (Postgres ohne Supabase).
 * Gegen Supabase werden Migrationen ausschließlich per `npx supabase db push`
 * angewendet – dieser Runner ist dafür NICHT gedacht.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const SHIMS_DIR = path.join(ROOT, "supabase", "dev-shims");

async function sqlFiles(dir: string): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  return files.map((f) => path.join(dir, f));
}

/** Löscht alle App-Schemas und baut die Datenbank aus Shims + Migrationen neu auf. */
export async function resetDatabase(connectionString: string, opts: { log?: boolean } = {}) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`drop schema if exists public, app, auth cascade; create schema public;`);
    for (const file of [...(await sqlFiles(SHIMS_DIR)), ...(await sqlFiles(MIGRATIONS_DIR))]) {
      const sql = await readFile(file, "utf8");
      try {
        await client.query(sql);
      } catch (err) {
        throw new Error(`Migration fehlgeschlagen: ${path.relative(ROOT, file)}\n${(err as Error).message}`);
      }
      if (opts.log) console.log(`✓ ${path.relative(ROOT, file)}`);
    }
  } finally {
    await client.end();
  }
}
