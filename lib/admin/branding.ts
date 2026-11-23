import "server-only";
/**
 * Erscheinungsbild des Mandanten (Admin → Erscheinungsbild): Logo, Claim,
 * Farben und Schriften. Speichern nur owner/admin (RLS auf tenants).
 * Farben werden streng geprüft (themeInputSchema) und müssen den
 * Mindestkontrast erreichen; das Logo liegt im Asset-Storage.
 */
import { withActor } from "@/lib/db";
import { assetStorage } from "@/lib/storage";
import type { AdminContext } from "@/lib/auth/admin";
import { AdminError, toAdminError } from "./errors";
import { mergeBrandingTheme, type BrandingInput } from "./branding-logic";

export const LOGO_MAX_BYTES = 1024 * 1024;

export type ImageType = { ext: "png" | "jpg" | "webp" | "svg"; contentType: string };

/** Dateityp am Inhalt erkennen (nicht an Name oder Browser-Angabe) */
export function detectImageType(buf: Buffer): ImageType | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: "png", contentType: "image/png" };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", contentType: "image/jpeg" };
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return { ext: "webp", contentType: "image/webp" };
  }
  const head = buf.toString("utf8", 0, Math.min(buf.length, 2048)).replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    return { ext: "svg", contentType: "image/svg+xml" };
  }
  return null;
}

/**
 * SVG darf keine aktiven Inhalte enthalten (Skripte, Event-Handler,
 * eingebettetes HTML, externe Verweise). Logos brauchen nichts davon.
 */
export function svgIsSafe(svg: string): boolean {
  const s = svg.toLowerCase();
  if (/<script\b|<foreignobject\b|<iframe\b|<embed\b|<object\b/.test(s)) return false;
  if (/\son[a-z]+\s*=/.test(s)) return false;
  if (/javascript:|data:text\/html|<!entity/.test(s)) return false;
  // nur interne Verweise (#id) bzw. eingebettete Rasterbilder
  for (const m of s.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/g)) {
    const v = m[1]!.trim();
    if (!v.startsWith("#") && !/^data:image\/(png|jpe?g|webp|gif);/.test(v)) return false;
  }
  if (/url\(\s*["']?(?!#)/.test(s)) return false;
  return true;
}

/** Logo hochladen und am Mandanten speichern */
export async function saveLogo(ctx: AdminContext, file: File): Promise<void> {
  if (ctx.role === "sales") throw new AdminError("forbidden");
  if (!file || file.size === 0) throw new AdminError("logo_invalid");
  if (file.size > LOGO_MAX_BYTES) throw new AdminError("logo_too_large");
  const buf = Buffer.from(await file.arrayBuffer());
  const type = detectImageType(buf);
  if (!type) throw new AdminError("logo_invalid");
  if (type.ext === "svg" && !svgIsSafe(buf.toString("utf8"))) throw new AdminError("logo_invalid");

  // neuer Dateiname je Upload -> kein veraltetes Logo aus Caches
  const key = `${ctx.tenant.id}/logo-${Date.now()}.${type.ext}`;
  try {
    await assetStorage().put(key, buf, type.contentType);
  } catch (err) {
    console.error("Logo-Upload fehlgeschlagen", err);
    throw new AdminError("logo_upload_failed");
  }
  await updateTenant(ctx, "update public.tenants set logo_path = $2 where id = $1", [ctx.tenant.id, key]);
}

/** Logo entfernen (Header zeigt dann den Namen als Text) */
export async function removeLogo(ctx: AdminContext): Promise<void> {
  if (ctx.role === "sales") throw new AdminError("forbidden");
  await updateTenant(ctx, "update public.tenants set logo_path = null where id = $1", [ctx.tenant.id]);
}

/** Claim, Farben und Schriften speichern */
export async function saveBranding(ctx: AdminContext, input: BrandingInput): Promise<void> {
  if (ctx.role === "sales") throw new AdminError("forbidden");
  const current = await withActor(ctx.actor, async (db) => {
    const { rows } = await db.query<{ theme: unknown }>("select theme from public.tenants where id = $1", [ctx.tenant.id]);
    return rows[0]?.theme;
  });
  const merged = mergeBrandingTheme(current, input);
  if (!merged.ok) throw new AdminError(merged.error);
  await updateTenant(ctx, "update public.tenants set theme = $2::jsonb, claim = $3 where id = $1", [
    ctx.tenant.id,
    JSON.stringify(merged.theme),
    input.claim,
  ]);
}

async function updateTenant(ctx: AdminContext, sql: string, params: unknown[]): Promise<void> {
  try {
    await withActor(ctx.actor, async (db) => {
      const res = await db.query(sql, params);
      if (res.rowCount === 0) throw new AdminError("forbidden");
    });
  } catch (err) {
    throw toAdminError(err);
  }
}
