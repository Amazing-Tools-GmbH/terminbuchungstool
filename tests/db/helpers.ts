import pg from "pg";
import { resetDatabase } from "@/lib/db/migrate";
import { runSeed, type SeededInvitation } from "@/scripts/seed";
import { type DbActor, withActorOn } from "@/lib/db/actor";

export function testDbUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL fehlt (siehe .env.example)");
  // DB-Tests laufen IMMER gegen eine lokale Wegwerf-DB (mit Dev-Shims) – nie
  // gegen Supabase, egal welche SUPABASE_*-Variablen gesetzt sind.
  const host = new URL(url).hostname;
  if (
    (process.env.SUPABASE_DB_URL && url === process.env.SUPABASE_DB_URL) ||
    /(^|\.)(supabase\.co|supabase\.com|pooler\.supabase\.com)$/.test(host)
  ) {
    throw new Error("TEST_DATABASE_URL darf nicht auf Supabase zeigen – Tests setzen die DB komplett zurück!");
  }
  return url;
}

export type TestDb = {
  pool: pg.Pool;
  seed: SeededInvitation[];
  as: <T>(actor: DbActor, fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>;
  /** Abfrage als Verbindungsrolle (wie service_role, ohne RLS) */
  admin: <R extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>;
  close: () => Promise<void>;
};

/** Setzt die Testdatenbank zurück, spielt den Seed ein und liefert Helfer. */
export async function setupTestDb(): Promise<TestDb> {
  const url = testDbUrl();
  await resetDatabase(url);
  const seed = await runSeed(url, { quiet: true });
  const pool = new pg.Pool({ connectionString: url, max: 30 });
  return {
    pool,
    seed,
    as: (actor, fn) => withActorOn(pool, actor, fn),
    admin: async (sql, params) => (await pool.query(sql, params)).rows,
    close: () => pool.end(),
  };
}

/** Postgres-Fehlercode "TB:<code>" aus book_slot & Co. */
export function tbCode(err: unknown): string | null {
  const msg = (err as { message?: string })?.message ?? "";
  return msg.startsWith("TB:") ? msg.slice(3) : null;
}
