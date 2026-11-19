"use server";
/**
 * Server Actions des Admin-Backends. Jede Action prüft die Sitzung, validiert
 * mit zod und ruft lib/admin; die eigentliche Rechteprüfung macht RLS.
 * Ergebnis per Redirect mit ?ok= bzw. ?error= (funktioniert ohne JavaScript).
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/admin";
import { toAdminError } from "@/lib/admin/errors";
import { capacitySchema, createSlotSchema, enableMemberSchema, updateMemberSchema } from "@/lib/admin/input";
import { createSlot, increaseCapacity } from "@/lib/admin/slots";
import { enableMember, updateMember } from "@/lib/admin/members";

function back(path: string, params: Record<string, string | undefined>): never {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  redirect(s ? `${path}?${s}` : path);
}

async function run(fn: () => Promise<void>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return toAdminError(err).code;
  }
}

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v : undefined;
};

export async function increaseCapacityAction(form: FormData) {
  const ctx = await requireAdmin();
  const event = str(form, "event");
  const parsed = capacitySchema.safeParse({ slotId: str(form, "slotId"), by: str(form, "by") ?? 1 });
  const error = parsed.success ? await run(() => increaseCapacity(ctx, parsed.data.slotId, parsed.data.by)) : "invalid_input";
  revalidatePath("/admin");
  back("/admin", { event, slot: parsed.success ? parsed.data.slotId : undefined, error, ok: error ? undefined : "capacity" });
}

export async function createSlotAction(form: FormData) {
  const ctx = await requireAdmin();
  const parsed = createSlotSchema.safeParse({
    eventId: str(form, "eventId"),
    date: str(form, "date"),
    from: str(form, "from"),
    to: str(form, "to"),
    location: str(form, "location") ?? "",
    capacity: str(form, "capacity"),
    open: form.get("open") === "on",
  });
  let slotId: string | undefined;
  const error = parsed.success
    ? await run(async () => {
        slotId = await createSlot(ctx, parsed.data);
      })
    : "invalid_input";
  revalidatePath("/admin");
  back("/admin", { event: str(form, "eventId"), slot: slotId, error, ok: error ? undefined : "slot" });
}

export async function enableMemberAction(form: FormData) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const parsed = enableMemberSchema.safeParse({ pipedriveUserId: str(form, "pipedriveUserId"), role: str(form, "role") });
  const error = parsed.success ? await run(() => enableMember(ctx, parsed.data.pipedriveUserId, parsed.data.role)) : "invalid_input";
  revalidatePath("/admin/benutzer");
  back("/admin/benutzer", { error, ok: error ? undefined : "saved" });
}

export async function updateMemberAction(form: FormData) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const parsed = updateMemberSchema.safeParse({
    userId: str(form, "userId"),
    role: str(form, "role") || undefined,
    status: str(form, "status") || undefined,
  });
  const error = parsed.success
    ? await run(() => updateMember(ctx, parsed.data.userId, { role: parsed.data.role, status: parsed.data.status }))
    : "invalid_input";
  revalidatePath("/admin/benutzer");
  back("/admin/benutzer", { error, ok: error ? undefined : "saved" });
}

