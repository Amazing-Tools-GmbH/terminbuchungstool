/**
 * Ablage für Mandanten-Assets (Logos). Bucket "tenant-assets", Schlüssel
 * "<tenant_id>/<datei>". Welche Ablage gilt, wird EXPLIZIT gewählt
 * (ASSET_STORAGE=local|supabase), nicht aus dem bloßen Vorhandensein von
 * SUPABASE_URL abgeleitet – lokale DB + Supabase-Storage passen nicht zusammen.
 *   local:    .data/dev-assets/ (lokale Dev-DB, Tests)
 *   supabase: Supabase Storage (Deployment, Seed gegen Supabase)
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const ASSET_BUCKET = "tenant-assets";

export interface AssetStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  publicUrl(key: string): string;
}

const SAFE_KEY = /^[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,100}$/;
export function isSafeAssetKey(key: string): boolean {
  return SAFE_KEY.test(key) && !key.includes("..");
}
function assertKey(key: string) {
  if (!isSafeAssetKey(key)) throw new Error(`Ungültiger Asset-Schlüssel: ${key}`);
}

/** Lokale Ablage (gitignored); ausgeliefert über app/dev-assets/[...key]/route.ts */
export const LOCAL_ASSET_ROOT = path.join(process.cwd(), ".data", "dev-assets");

/** Lokale Übergangslösung ohne Supabase Storage */
export class LocalAssetStorage implements AssetStorage {
  constructor(private readonly root = LOCAL_ASSET_ROOT) {}
  async put(key: string, body: Buffer): Promise<void> {
    assertKey(key);
    const file = path.join(this.root, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  }
  publicUrl(key: string): string {
    assertKey(key);
    return `/dev-assets/${key}`;
  }
}

/** Supabase Storage (öffentlicher Bucket), Upload per Service-Role-Key */
export class SupabaseAssetStorage implements AssetStorage {
  constructor(
    private readonly url: string,
    private readonly serviceRoleKey?: string,
  ) {}
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertKey(key);
    if (!this.serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY fehlt für Uploads");
    const res = await fetch(`${this.url}/storage/v1/object/${ASSET_BUCKET}/${key}`, {
      method: "POST",
      headers: {
        apikey: this.serviceRoleKey,
        authorization: `Bearer ${this.serviceRoleKey}`,
        "content-type": contentType,
        "x-upsert": "true",
      },
      body: new Uint8Array(body),
    });
    if (!res.ok) throw new Error(`Upload fehlgeschlagen (${res.status}): ${await res.text()}`);
  }
  publicUrl(key: string): string {
    assertKey(key);
    return `${this.url}/storage/v1/object/public/${ASSET_BUCKET}/${key}`;
  }
}

export type AssetStorageKind = "local" | "supabase";

/** ASSET_STORAGE auswerten (Standard: local). Unbekannte Werte sind ein Konfigurationsfehler. */
export function assetStorageKind(env: Record<string, string | undefined> = process.env): AssetStorageKind {
  const v = (env.ASSET_STORAGE ?? "").trim() || "local";
  if (v !== "local" && v !== "supabase") throw new Error(`ASSET_STORAGE muss "local" oder "supabase" sein, ist "${v}"`);
  return v;
}

export function createAssetStorage(
  kind: AssetStorageKind,
  env: Record<string, string | undefined> = process.env,
): AssetStorage {
  if (kind === "local") return new LocalAssetStorage();
  if (!env.SUPABASE_URL) throw new Error("ASSET_STORAGE=supabase, aber SUPABASE_URL fehlt");
  return new SupabaseAssetStorage(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

/** Ablage gemäß ASSET_STORAGE (App-Laufzeit). */
export function assetStorage(env: Record<string, string | undefined> = process.env): AssetStorage {
  return createAssetStorage(assetStorageKind(env), env);
}
