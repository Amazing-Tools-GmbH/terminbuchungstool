import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { ANON, withActor } from "@/lib/db";
import { assetStorage } from "@/lib/storage";
import { TENANT_HEADER, decodeTenantKey } from "./host";
import { parsePublicTenant } from "./parse";
import type { PublicTenant } from "./types";

/** Mandant des aktuellen Requests (pro Request gecacht), null = keiner */
export const getCurrentTenant = cache(async (): Promise<PublicTenant | null> => {
  const key = decodeTenantKey((await headers()).get(TENANT_HEADER));
  if (!key) return null;

  if (key.kind === "token") return tenantForToken(key.token, key.domain);
  const row = await withActor(ANON, async (db) => {
    const { rows } = await db.query<{ t: Record<string, unknown> | null }>(
      "select public.resolve_tenant($1, $2) as t",
      [key.kind === "slug" ? key.slug : null, key.kind === "domain" ? key.domain : null],
    );
    return rows[0]?.t ?? null;
  });
  return row ? toTenant(row) : null;
});

function toTenant(row: Record<string, unknown>): PublicTenant {
  const storage = assetStorage();
  return parsePublicTenant(row, (k) => storage.publicUrl(k));
}

/**
 * Mandant zu einem Buchungslink. Auf einer eigenen Kundendomain (domain)
 * muss der Link zu diesem Mandanten gehören, sonst null.
 */
export async function tenantForToken(token: string, domain: string | null): Promise<PublicTenant | null> {
  const row = await withActor(ANON, async (db) => {
    const { rows } = await db.query<{ t: Record<string, unknown> | null }>("select public.resolve_tenant_by_token($1) as t", [token]);
    return rows[0]?.t ?? null;
  });
  if (!row) return null;
  const tenant = toTenant(row);
  if (domain && tenant.customDomain !== domain) return null;
  return tenant;
}

/** Für API-Routen mit Token im Body: eigene Kundendomain des Hosts (falls vorhanden) */
export async function hostCustomDomain(): Promise<string | null> {
  const key = decodeTenantKey((await headers()).get(TENANT_HEADER));
  if (key?.kind === "domain") return key.domain;
  if (key?.kind === "token") return key.domain;
  return null;
}

/** Mandant für ein bereits authentifiziertes Mitglied (zentrale Sitzung) */
export async function tenantForMember(userId: string, tenantId: string): Promise<PublicTenant | null> {
  const row = await withActor({ role: "authenticated", userId }, async (db) => {
    const { rows } = await db.query<{ t: Record<string, unknown> | null }>("select public.resolve_tenant_by_id($1) as t", [tenantId]);
    return rows[0]?.t ?? null;
  });
  return row ? toTenant(row) : null;
}
