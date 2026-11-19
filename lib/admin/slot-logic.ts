/** Termine: reine Logik (ohne DB), testbar */
export type SlotLevel = "ok" | "low" | "full" | "closed" | "cancelled";

/** Gleiche Schwelle wie die Buchungsseite ("fast voll" ab 3 freien Plätzen) */
export function slotLevel(status: string, capacity: number, booked: number): SlotLevel {
  if (status === "cancelled") return "cancelled";
  if (status === "closed") return "closed";
  const free = capacity - booked;
  if (free <= 0) return "full";
  return free <= 3 ? "low" : "ok";
}

export function kpis(slots: { level: SlotLevel; capacity: number; booked: number }[]) {
  const active = slots.filter((s) => s.level !== "cancelled");
  const capacity = active.reduce((n, s) => n + s.capacity, 0);
  const booked = active.reduce((n, s) => n + s.booked, 0);
  return { slots: active.length, capacity, booked, pct: capacity ? Math.round((booked / capacity) * 100) : 0 };
}

export function dealUrl(companyDomain: string | null, dealId: string | number | null): string | null {
  if (!companyDomain || dealId === null || dealId === undefined) return null;
  return `https://${companyDomain}.pipedrive.com/deal/${encodeURIComponent(String(dealId))}`;
}

