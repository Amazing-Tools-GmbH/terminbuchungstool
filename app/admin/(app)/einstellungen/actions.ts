"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/admin";
import { toAdminError } from "@/lib/admin/errors";
import { legalLinksFromForm, saveSettings, settingsSchema } from "@/lib/admin/settings";

const PATH = "/admin/einstellungen";

export async function saveSettingsAction(form: FormData) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const parsed = settingsSchema.safeParse({
    name: form.get("name") ?? "",
    senderName: form.get("senderName") ?? "",
    replyTo: form.get("replyTo") ?? "",
    anrede: form.get("anrede"),
    contactLine: form.get("contactLine") ?? "",
    changeDeadlineHours: form.get("changeDeadlineHours"),
    retentionMonths: form.get("retentionMonths"),
    legalLinks: legalLinksFromForm(form),
  });
  let error: string | undefined = parsed.success ? undefined : "invalid_input";
  if (parsed.success) {
    try {
      await saveSettings(ctx, parsed.data);
    } catch (err) {
      error = toAdminError(err).code;
    }
  }
  revalidatePath("/", "layout");
  redirect(`${PATH}?${new URLSearchParams(error ? { error } : { ok: "settings" })}`);
}
