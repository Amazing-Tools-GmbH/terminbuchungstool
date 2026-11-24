"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/admin";
import { toAdminError } from "@/lib/admin/errors";
import { retryActivity } from "@/lib/admin/activity";
import { sendMailsSoon } from "@/lib/booking/api";

const schema = z.object({ source: z.enum(["mail", "pipedrive"]), id: z.string().uuid(), back: z.string().max(500).optional() });

export async function retryAction(form: FormData) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const parsed = schema.safeParse({ source: form.get("source"), id: form.get("id"), back: form.get("back") ?? undefined });
  let error: string | undefined = parsed.success ? undefined : "invalid_input";
  if (parsed.success) {
    try {
      if (await retryActivity(ctx, parsed.data.source, parsed.data.id)) sendMailsSoon(ctx.tenant.id);
    } catch (err) {
      error = toAdminError(err).code;
    }
  }
  revalidatePath("/admin/verlauf");
  // zurück zur gleichen Ansicht (nur eigene Pfade)
  const back = parsed.success && parsed.data.back?.startsWith("/admin/verlauf") ? parsed.data.back : "/admin/verlauf";
  const url = new URL(back, "http://x");
  url.searchParams.delete("ok");
  url.searchParams.delete("error");
  url.searchParams.set(error ? "error" : "ok", error ?? "retried");
  redirect(`${url.pathname}${url.search}`);
}
