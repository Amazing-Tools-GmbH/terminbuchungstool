import "server-only";
/**
 * Verdrahtung der Pipedrive-Aufträge zur Laufzeit: echte API oder (lokal,
 * PIPEDRIVE_DIRECTORY=fake) Beispiel-Deals aus seed/tenants.ts.
 */
import { getPool } from "@/lib/db/pool";
import { SEED_TENANTS } from "@/seed/tenants";
import { ApiPipedriveCrm, FakePipedriveCrm, type PipedriveApiAccess, type PipedriveCrm } from "./crm";
import { directorySource } from "./directory";
import { pipedriveAccess, tenantIdForCompany } from "./connection";
import { withActor } from "@/lib/db";
import { userPipedriveAccess } from "./user-connection";
import { processPipedriveJobs, type PdJobDeps } from "./jobs";

let fake: FakePipedriveCrm | null = null;

export function pipedriveCrm(): PipedriveCrm {
  if (directorySource() === "api") return new ApiPipedriveCrm();
  fake ??= new FakePipedriveCrm(
    Object.fromEntries(SEED_TENANTS.flatMap((t) => (t.pipedrive.deals ?? []).map((d) => [d.id, { title: d.title, person: d.person, org: d.org }]))),
  );
  return fake;
}

/** Zugang: bevorzugt der Mitarbeiter (eigene Tokens), sonst die Installation */
export async function pipedriveApiAccess(tenantId: string, userId: string | null): Promise<PipedriveApiAccess | null> {
  if (directorySource() === "fake") return { apiDomain: "https://fake.pipedrive.invalid", accessToken: "fake" };
  if (userId) {
    try {
      return await userPipedriveAccess(getPool(), tenantId, userId);
    } catch {
      // kein/abgelaufener Benutzer-Zugang -> Zugang der Installation
    }
  }
  const a = await pipedriveAccess(tenantId);
  return a ? { apiDomain: a.apiDomain, accessToken: a.accessToken } : null;
}

export const pipedriveJobDeps = (): PdJobDeps => ({ crm: pipedriveCrm(), access: pipedriveApiAccess });

export function runPipedriveJobs(opts: { tenantId?: string; limit?: number } = {}) {
  return processPipedriveJobs(getPool(), pipedriveJobDeps(), opts);
}

/**
 * Mandant zur Pipedrive-Firma. Lokal (PIPEDRIVE_DIRECTORY=fake) ohne echte
 * Installation: Firmen-ID der Seed-Daten -> Mandant mit diesem Slug.
 */
export async function tenantIdForPipedriveCompany(companyId: number): Promise<string | null> {
  const id = await tenantIdForCompany(companyId);
  if (id || directorySource() !== "fake") return id;
  const seed = SEED_TENANTS.find((t) => t.pipedrive.companyId === companyId);
  if (!seed) return null;
  return withActor({ role: "service_role" }, async (db) => {
    const { rows } = await db.query<{ id: string }>("select id from public.tenants where slug = $1", [seed.slug]);
    return rows[0]?.id ?? null;
  });
}
