/**
 * Datenzugriff mit RLS – derselbe Weg lokal und auf Supabase.
 *
 * Jeder Zugriff läuft in einer Transaktion, in der wir wie PostgREST die
 * Datenbankrolle wechseln (SET LOCAL ROLE) und die JWT-Claims setzen.
 * Dadurch greifen die RLS-Policies der Datenbank; der App-Code filtert
 * NICHT selbst nach tenant_id, um Isolation herzustellen.
 */
import type pg from "pg";

export type DbActor =
  | { role: "anon" }
  | { role: "authenticated"; userId: string }
  /** Nur für Server-Jobs (Outbox, Pipedrive-Installation, Seed). Umgeht RLS! */
  | { role: "service_role" };

export const ANON: DbActor = { role: "anon" };

export function claimsFor(actor: DbActor): Record<string, unknown> {
  switch (actor.role) {
    case "anon":
      return { role: "anon" };
    case "authenticated":
      return { role: "authenticated", sub: actor.userId };
    case "service_role":
      return { role: "service_role" };
  }
}

/** Führt fn in einer Transaktion als actor aus. Fehler -> Rollback. */
export async function withActorOn<T>(
  pool: pg.Pool,
  actor: DbActor,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Rolle stammt aus einer festen Union, nie aus Benutzereingaben
    await client.query(`set local role ${actor.role}`);
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claimsFor(actor))]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
