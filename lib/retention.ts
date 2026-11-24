/**
 * Löschfrist für personenbezogene Daten (tenants.retention_months).
 * Aufruf aus dem Server-Cron; die DB-Funktion arbeitet je Mandant höchstens
 * einmal am Tag (tenants.data_purged_at), p_force nur für Tests/Betrieb.
 */
import type pg from "pg";
import { withActorOn } from "@/lib/db/actor";

export type PurgeResult = { tenants: number; bookings: number; invitations: number; mails: number; pipedrive_jobs: number; activity_log: number };

export async function purgeExpiredData(pool: pg.Pool, opts: { force?: boolean } = {}): Promise<PurgeResult> {
  return withActorOn(pool, { role: "service_role" }, async (db) => {
    const { rows } = await db.query<{ r: PurgeResult }>("select public.purge_expired_data($1) as r", [opts.force ?? false]);
    const r = rows[0]!.r;
    if (r.bookings || r.invitations || r.mails) console.info("[löschfrist]", JSON.stringify(r));
    return r;
  });
}
