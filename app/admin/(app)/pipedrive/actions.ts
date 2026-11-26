"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/admin";
import { toAdminError } from "@/lib/admin/errors";
import { disconnectPipedrive, testConnection } from "@/lib/pipedrive/manage";
import { pipedriveSettingsSchema, savePipedriveSettings } from "@/lib/admin/pipedrive-settings";

const PATH = "/admin/pipedrive";

export async function testPipedriveAction() {
  const ctx = await requireAdmin(["owner", "admin"]);
  let q: URLSearchParams;
  try {
    const r = await testConnection(ctx);
    q = new URLSearchParams({ test: "ok", company: (r.companyName ?? "").slice(0, 120), user: r.user.slice(0, 120) });
  } catch (err) {
    q = new URLSearchParams({ error: toAdminError(err).code });
  }
  redirect(`${PATH}?${q}`);
}

export async function disconnectPipedriveAction(form: FormData) {
  const ctx = await requireAdmin(["owner"]);
  if (form.get("confirm") !== "yes") redirect(`${PATH}?error=invalid_input`);
  let error: string | undefined;
  try {
    await disconnectPipedrive(ctx);
  } catch (err) {
    error = toAdminError(err).code;
  }
  revalidatePath(PATH);
  redirect(`${PATH}?${new URLSearchParams(error ? { error } : { ok: "pdDisconnected" })}`);
}

export async function savePipedriveSettingsAction(form: FormData) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const stage = String(form.get("stage") ?? "");
  // Phase als "pipeline:stage" (eine Auswahl für beides)
  const [pipelineId, stageId] = stage.includes(":") ? stage.split(":") : ["", ""];
  const parsed = pipedriveSettingsSchema.safeParse({
    activityType: form.get("activityType"),
    panelPerson: form.get("panelPerson"),
    pipelineId,
    stageId,
  });
  let error: string | undefined;
  if (!parsed.success) error = "invalid_input";
  else {
    try {
      await savePipedriveSettings(ctx, parsed.data);
    } catch (err) {
      error = toAdminError(err).code;
    }
  }
  revalidatePath(PATH);
  redirect(`${PATH}?${new URLSearchParams(error ? { error } : { ok: "pdSettings" })}`);
}
