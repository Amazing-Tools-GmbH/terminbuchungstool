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

  const row = await withActor(ANON, async (db) => {
    const { rows } = await db.query<{ t: Record<string, unknown> | null }>(
      "select public.resolve_tenant($1, $2) as t",
      [key.kind === "slug" ? key.slug : null, key.kind === "domain" ? key.domain : null],
    );
    return rows[0]?.t ?? null;
  });
  if (!row) return null;

  const storage = assetStorage();
  return parsePublicTenant(row, (k) => storage.publicUrl(k));
});
