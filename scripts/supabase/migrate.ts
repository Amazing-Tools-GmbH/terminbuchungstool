/**
 * Wendet die Migrationen aus supabase/migrations/ über die Supabase
 * Management API an (kein direkter DB-Zugang nötig) und trägt sie – wie die
 * Supabase-CLI – in supabase_migrations.schema_migrations ein. Dadurch kann
 * später `supabase db push` konsistent weiterarbeiten.
 *
 * Die Dev-Shims (supabase/dev-shims/) werden hier NIE angewendet.
 *
 * Aufruf: npm run supabase:migrate              (wendet fehlende an)
 *         npm run supabase:migrate -- --dry-run (zeigt nur, was fehlt)
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inlineParams, managementQuery } from "./api";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const FILE_RE = /^(\d{14})_([a-z0-9_]+)\.sql$/;

/** Gleiche Struktur wie die Supabase-CLI sie anlegt. */
const ENSURE_HISTORY = `
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text not null primary key);
alter table supabase_migrations.schema_migrations add column if not exists statements text[];
alter table supabase_migrations.schema_migrations add column if not exists name text;
`;

export type LocalMigration = { version: string; name: string; file: string };

export async function localMigrations(): Promise<LocalMigration[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  return files.map((f) => {
    const m = FILE_RE.exec(f);
    if (!m) throw new Error(`Ungültiger Migrationsname: ${f} (erwartet <YYYYMMDDHHMMSS>_<name>.sql)`);
    return { version: m[1]!, name: m[2]!, file: path.join(MIGRATIONS_DIR, f) };
  });
}

export async function appliedVersions(): Promise<Set<string>> {
  const [exists] = await managementQuery<{ t: boolean }>(
    `select to_regclass('supabase_migrations.schema_migrations') is not null as t`,
  );
  if (!exists?.t) return new Set();
  const rows = await managementQuery<{ version: string }>(
    `select version from supabase_migrations.schema_migrations order by version`,
  );
  return new Set(rows.map((r) => r.version));
}

export async function migrateSupabase(opts: { dryRun?: boolean } = {}) {
  if (!opts.dryRun) await managementQuery(ENSURE_HISTORY); // Probelauf schreibt nichts
  const applied = await appliedVersions();
  const all = await localMigrations();

  // Remote kennt Versionen, die es lokal nicht gibt? -> nicht raten, abbrechen
  const unknown = [...applied].filter((v) => !all.some((m) => m.version === v));
  if (unknown.length) {
    throw new Error(`Auf Supabase sind Migrationen eingetragen, die lokal fehlen: ${unknown.join(", ")}`);
  }
  // Lücken (ältere lokale Migration fehlt remote, neuere ist eingetragen) -> abbrechen
  const latest = [...applied].sort().at(-1);
  const pending = all.filter((m) => !applied.has(m.version));
  const outOfOrder = latest ? pending.filter((m) => m.version < latest) : [];
  if (outOfOrder.length) {
    throw new Error(`Migrationen außer der Reihe (älter als ${latest}): ${outOfOrder.map((m) => m.version).join(", ")}`);
  }

  if (!pending.length) {
    console.log("Supabase ist auf dem neuesten Stand – keine Migration offen.");
    return;
  }
  for (const m of pending) {
    if (opts.dryRun) {
      console.log(`offen: ${m.version}_${m.name}`);
      continue;
    }
    const sql = await readFile(m.file, "utf8");
    // Migration und Eintrag in EINER Abfrage: Postgres führt mehrere
    // Anweisungen einer einfachen Abfrage als implizite Transaktion aus –
    // scheitert etwas, bleibt weder Schema-Änderung noch Eintrag zurück.
    const record = inlineParams(
      `insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3::text[])`,
      [m.version, m.name, pgTextArray([sql])],
    );
    try {
      await managementQuery(`${sql}\n;\n${record};`);
    } catch (err) {
      throw new Error(`Migration ${m.version}_${m.name} fehlgeschlagen:\n${(err as Error).message}`);
    }
    console.log(`✓ ${m.version}_${m.name}`);
  }
}

/** JS-Array -> Postgres-Array-Literal für text[] */
function pgTextArray(items: string[]): string {
  return `{${items.map((s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await migrateSupabase({ dryRun: process.argv.includes("--dry-run") });
}
