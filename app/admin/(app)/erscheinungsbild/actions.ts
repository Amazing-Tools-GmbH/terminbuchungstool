"use server";
/** Erscheinungsbild: Logo, Claim, Farben, Schriften (nur owner/admin) */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/admin";
import { toAdminError } from "@/lib/admin/errors";
import { brandingInputSchema } from "@/lib/admin/branding-logic";
import { removeLogo, saveBranding, saveLogo } from "@/lib/admin/branding";

const PATH = "/admin/erscheinungsbild";

function done(result: { ok?: string; error?: string }): never {
  revalidatePath(PATH);
  redirect(`${PATH}?${new URLSearchParams(result.error ? { error: result.error } : { ok: result.ok ?? "saved" })}`);
}

async function attempt(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return toAdminError(err).code;
  }
}

export async function uploadLogoAction(form: FormData) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const file = form.get("logo");
  const error = file instanceof File ? await attempt(() => saveLogo(ctx, file)) : "logo_invalid";
  done(error ? { error } : { ok: "logo" });
}

export async function removeLogoAction() {
  const ctx = await requireAdmin(["owner", "admin"]);
  const error = await attempt(() => removeLogo(ctx));
  done(error ? { error } : { ok: "logoRemoved" });
}

export async function saveBrandingAction(form: FormData) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const colors: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (k.startsWith("color.") && typeof v === "string") colors[k.slice(6)] = v;
  const parsed = brandingInputSchema.safeParse({
    claim: form.get("claim") ?? "",
    fontBody: form.get("fontBody"),
    fontDisplay: form.get("fontDisplay"),
    colors,
  });
  if (!parsed.success) done({ error: "invalid_input" });
  const error = await attempt(() => saveBranding(ctx, parsed.data));
  done(error ? { error } : { ok: "branding" });
}
