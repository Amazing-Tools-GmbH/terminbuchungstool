import "server-only";
/**
 * Übersicht (Dashboard): Auslastung aller kommenden Termine im gewählten
 * Zeitraum, je Event zusammengefasst. Lesen als angemeldeter Benutzer (RLS).
 */
import type { AdminContext } from "@/lib/auth/admin";
import { listEvents, listSlots, type AdminSlot } from "./slots";
import { kpis } from "./slot-logic";

export const DASHBOARD_RANGES = ["7", "30", "90", "all"] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

export type DashboardSlot = AdminSlot & { eventId: string; eventTitle: string };
export type DashboardEvent = { id: string; title: string; slots: number; capacity: number; booked: number; pct: number; full: number };

export async function loadDashboard(ctx: AdminContext, range: DashboardRange) {
  const events = await listEvents(ctx);
  const until = range === "all" ? Infinity : Date.now() + Number(range) * 86_400_000;
  const perEvent = await Promise.all(
    events.map(async (e) => ({
      event: e,
      slots: (await listSlots(ctx, e.id)).filter((s) => s.level !== "cancelled" && new Date(s.startsAt).getTime() <= until),
    })),
  );
  const slots: DashboardSlot[] = perEvent
    .flatMap(({ event, slots }) => slots.map((s) => ({ ...s, eventId: event.id, eventTitle: event.title })))
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  const byEvent: DashboardEvent[] = perEvent
    .filter((p) => p.slots.length > 0)
    .map(({ event, slots }) => ({ id: event.id, title: event.title, ...kpis(slots), full: slots.filter((s) => s.level === "full").length }));
  return { totals: { ...kpis(slots), full: slots.filter((s) => s.level === "full").length }, byEvent, slots };
}
