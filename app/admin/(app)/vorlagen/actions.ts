"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/admin";
import { toAdminError } from "@/lib/admin/errors";
import { isMailTemplateKey } from "@/lib/admin/mail-templates";
import { saveMailTemplates } from "@/lib/admin/mail-templates-store";

const PATH = "/admin/vorlagen";

export async function saveTemplatesAction(form: FormData) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const input: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    const key = k.startsWith("t.") ? k.slice(2) : "";
    if (isMailTemplateKey(key) && typeof v === "string") input[key] = v;
  }
  const group = form.get("group");
  let error: string | undefined;
  try {
    await saveMailTemplates(ctx, input);
  } catch (err) {
    error = toAdminError(err).code;
  }
  revalidatePath(PATH);
  const q = new URLSearchParams(error ? { error } : { ok: "templates" });
  if (typeof group === "string" && /^[a-zA-Z]{1,30}$/.test(group)) q.set("mail", group);
  redirect(`${PATH}?${q}`);
}
