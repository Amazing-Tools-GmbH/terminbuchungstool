import "server-only";
/**
 * Benutzerverzeichnis der Pipedrive-Firma eines Mandanten (für die
 * Nutzerverwaltung). Die Quelle wird explizit gewählt:
 *
 *   PIPEDRIVE_DIRECTORY=api   Pipedrive-API mit dem Token der Installation (Standard)
 *   PIPEDRIVE_DIRECTORY=fake  Beispiel-Benutzer aus seed/tenants.ts – nur für die
 *                             lokale Entwicklung, solange es keine OAuth-App gibt
 */
import { SEED_TENANTS } from "@/seed/tenants";
import { listUsers, type PipedriveUser } from "./client";
import { pipedriveAccess } from "./connection";

export type DirectoryResult =
  | { ok: true; users: PipedriveUser[]; source: "api" | "fake" }
  | { ok: false; reason: "not_connected" | "unavailable" };

export type DirectoryTenant = { id: string; slug: string };

export function directorySource(env: Record<string, string | undefined> = process.env): "api" | "fake" {
  const v = env.PIPEDRIVE_DIRECTORY?.trim();
  if (!v || v === "api") return "api";
  if (v === "fake") {
    if (env.NODE_ENV === "production" && env.ALLOW_FAKE_PIPEDRIVE !== "true") {
      throw new Error("PIPEDRIVE_DIRECTORY=fake ist in Produktion nicht erlaubt");
    }
    return "fake";
  }
  throw new Error(`PIPEDRIVE_DIRECTORY ungültig: ${v} (api | fake)`);
}

export async function listPipedriveUsers(tenant: DirectoryTenant): Promise<DirectoryResult> {
  if (directorySource() === "fake") {
    const seed = SEED_TENANTS.find((t) => t.slug === tenant.slug);
    if (!seed) return { ok: false, reason: "not_connected" };
    return {
      ok: true,
      source: "fake",
      users: seed.pipedrive.users.map(({ id, name, email, isAdmin, active }) => ({ id, name, email: email.toLowerCase(), isAdmin, active })),
    };
  }
  try {
    const access = await pipedriveAccess(tenant.id);
    if (!access) return { ok: false, reason: "not_connected" };
    return { ok: true, source: "api", users: await listUsers(access.apiDomain, access.accessToken) };
  } catch (err) {
    console.error("Pipedrive-Benutzer konnten nicht geladen werden:", (err as Error).message);
    return { ok: false, reason: "unavailable" };
  }
}
