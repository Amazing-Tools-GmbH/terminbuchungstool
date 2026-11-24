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
import {
  cancelBookingSchema,
  cancelSlotSchema,
  capacitySchema,
  createEventSchema,
  createSlotSchema,
  deleteEventSchema,
  enableMemberSchema,
  updateEventSchema,
  updateMemberSchema,
  updateSlotSchema,
} from "@/lib/admin/input";
import { cancelBookingByTeam, cancelSlot, deleteEvent, updateEvent, updateSlot } from "@/lib/admin/maintenance";
import { createEvent, createSlot, setCapacity } from "@/lib/admin/slots";
import { enableMember, updateMember } from "@/lib/admin/members";
import { sendMailsSoon } from "@/lib/booking/api";

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

export async function setCapacityAction(form: FormData) {
  const ctx = await requireAdmin();
  const event = str(form, "event");
  const parsed = capacitySchema.safeParse({ slotId: str(form, "slotId"), capacity: str(form, "capacity") });
  const error = parsed.success ? await run(() => setCapacity(ctx, parsed.data.slotId, parsed.data.capacity)) : "invalid_input";
  revalidatePath("/admin");
  back("/admin", { event, error, ok: error ? undefined : "capacity" });
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
  const error = parsed.success
    ? await run(async () => {
        await createSlot(ctx, parsed.data);
      })
    : "invalid_input";
  revalidatePath("/admin");
  back("/admin", { event: str(form, "eventId"), error, ok: error ? undefined : "slot" });
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


export async function createEventAction(form: FormData) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const parsed = createEventSchema.safeParse({
    title: str(form, "title"),
    location: str(form, "location") ?? "",
    description: str(form, "description") ?? "",
    date: str(form, "date"),
    from: str(form, "from"),
    to: str(form, "to"),
    capacity: str(form, "capacity"),
  });
  let created: { eventId: string } | undefined;
  const error = parsed.success
    ? await run(async () => {
        created = await createEvent(ctx, parsed.data);
      })
    : "invalid_input";
  revalidatePath("/admin");
  back("/admin", { event: created?.eventId, error, ok: error ? undefined : "event" });
}

// ---------------------------------------------------------------------
// Events, Termine und Buchungen pflegen (Haken „Teilnehmer informieren“)
// ---------------------------------------------------------------------

async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: toAdminError(err).code };
  }
}

export async function updateEventAction(form: FormData) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const parsed = updateEventSchema.safeParse({
    eventId: str(form, "eventId"),
    title: str(form, "title"),
    location: str(form, "location") ?? "",
    description: str(form, "description") ?? "",
  });
  const r = parsed.success ? await attempt(() => updateEvent(ctx, parsed.data)) : { ok: false as const, error: "invalid_input" };
  revalidatePath("/admin");
  back("/admin", { event: str(form, "eventId"), error: r.ok ? undefined : r.error, ok: r.ok ? "eventUpdated" : undefined });
}

export async function deleteEventAction(form: FormData) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const parsed = deleteEventSchema.safeParse({ eventId: str(form, "eventId"), notify: str(form, "notify"), confirm: str(form, "confirm") });
  const r = parsed.success ? await attempt(() => deleteEvent(ctx, parsed.data.eventId, parsed.data.notify)) : { ok: false as const, error: "invalid_input" };
  revalidatePath("/admin");
  if (!r.ok) back("/admin", { event: str(form, "eventId"), error: r.error });
  back("/admin", r.value.deleted ? { ok: "eventDeleted" } : { ok: "eventArchived", n: String(r.value.cancelled) });
}

export async function updateSlotAction(form: FormData) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const event = str(form, "event");
  const parsed = updateSlotSchema.safeParse({
    slotId: str(form, "slotId"),
    date: str(form, "date"),
    from: str(form, "from"),
    to: str(form, "to"),
    location: str(form, "location") ?? "",
    notify: str(form, "notify"),
  });
  const r = parsed.success ? await attempt(() => updateSlot(ctx, parsed.data)) : { ok: false as const, error: "invalid_input" };
  revalidatePath("/admin");
  if (!r.ok) back("/admin", { event, edit: str(form, "slotId"), error: r.error });
  // Mails (falls gewünscht) und Pipedrive-Aktivitäten gleich anstoßen
  if (r.value > 0) sendMailsSoon(ctx.tenant.id);
  back("/admin", { event, ok: parsed.success && parsed.data.notify && r.value > 0 ? "slotUpdatedNotified" : "slotUpdated", n: String(r.value) });
}

export async function cancelSlotAction(form: FormData) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const event = str(form, "event");
  const parsed = cancelSlotSchema.safeParse({ slotId: str(form, "slotId"), notify: str(form, "notify") });
  const r = parsed.success ? await attempt(() => cancelSlot(ctx, parsed.data.slotId, parsed.data.notify)) : { ok: false as const, error: "invalid_input" };
  revalidatePath("/admin");
  if (!r.ok) back("/admin", { event, edit: str(form, "slotId"), error: r.error });
  if (r.value > 0) sendMailsSoon(ctx.tenant.id);
  back("/admin", { event, ok: r.value > 0 ? "slotCancelled" : "slotDeleted", n: String(r.value) });
}

/** Buchung durch das Team stornieren (aus „Events & Termine“ oder „Buchungen“) */
export async function cancelBookingAction(form: FormData) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const parsed = cancelBookingSchema.safeParse({ bookingId: str(form, "bookingId"), notify: str(form, "notify") });
  const r = parsed.success ? await attempt(() => cancelBookingByTeam(ctx, parsed.data.bookingId, parsed.data.notify)) : { ok: false as const, error: "invalid_input" };
  if (r.ok) sendMailsSoon(ctx.tenant.id);
  const to = str(form, "back") === "list" ? "/admin/buchungen" : "/admin";
  revalidatePath(to);
  back(to, { event: str(form, "event"), slot: str(form, "slot"), error: r.ok ? undefined : r.error, ok: r.ok ? "bookingCancelled" : undefined });
}
