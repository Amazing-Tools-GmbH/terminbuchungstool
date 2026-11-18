import { readFile } from "node:fs/promises";
import path from "node:path";
import { LOCAL_ASSET_ROOT, assetStorageKind, isSafeAssetKey } from "@/lib/storage";

const TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/**
 * Liefert lokal abgelegte Mandanten-Assets aus (nur bei ASSET_STORAGE=local;
 * mit ASSET_STORAGE=supabase zeigen Logo-URLs direkt auf Supabase Storage).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  if (assetStorageKind() !== "local") return new Response("Not found", { status: 404 });
  const key = (await params).key.join("/");
  const type = TYPES[path.extname(key).toLowerCase()];
  if (!isSafeAssetKey(key) || !type) return new Response("Not found", { status: 404 });
  try {
    const body = await readFile(path.join(LOCAL_ASSET_ROOT, key));
    return new Response(new Uint8Array(body), {
      headers: {
        "content-type": type,
        "cache-control": "public, max-age=300",
        // SVG nie als aktives Dokument ausführen
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
