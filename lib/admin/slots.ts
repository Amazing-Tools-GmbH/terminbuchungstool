import "server-only";
import type { PoolClient } from "pg";
/**
 * Termine & Kapazitäten. Alle Zugriffe laufen als angemeldeter Benutzer
 * (withActor) – Lese- und Schreibrechte erzwingt RLS (sales: nur lesen).
 */
import { withActor } from "@/lib/db";
import { formatSlot } from "@/lib/datetime";
import type { AdminContext } from "@/lib/auth/admin";
import { AdminError, toAdminError } from "./errors";
import type { CreateEventInput, CreateSlotInput } from "./input";
import { dealUrl, slotLevel, type SlotLevel } from "./slot-logic";

export { kpis, type SlotLevel } from "./slot-logic";

export type AdminEvent = { id: string; title: string; location: string | null; status: string };

export type AdminSlot = {
  id: string;
  startsAt: Date;
  weekdayShort: string;
  date: string;
  time: string;
  location: string | null;
  capacity: number;
  booked: number;
  free: number;
  pct: number;
  level: SlotLevel;
};

export type AdminBooking = {
  id: string;
  name: string;
  email: string;
  organization: string | null;
  seats: number;
  extraAttendees: string[];
  dealUrl: string | null;
};

export async function listEvents(ctx: AdminContext): Promise<AdminEvent[]> {
  return withActor(ctx.actor, async (db) => {
    const { rows } = await db.query<AdminEvent>(
      `select id, title, location, status::text as status from public.events
        where tenant_id = $1 and status <> 'archived' order by created_at`,
      [ctx.tenant.id],
    );
    return rows;
  });
}

/** Kommende Termine einer Veranstaltung mit Belegung */
export async function listSlots(ctx: AdminContext, eventId: string): Promise<AdminSlot[]> {
  const rows = await withActor(ctx.actor, async (db) => {
    const { rows } = await db.query<{
      id: string;
      starts_at: Date;
      ends_at: Date;
      location: string | null;
      capacity: number;
      status: string;
      booked: number;
    }>(
      `select s.id, s.starts_at, s.ends_at, coalesce(s.location, e.location) as location, s.capacity, s.status::text as status,
              coalesce((select sum(b.seats) from public.bookings b
                         where b.slot_id = s.id and b.status = 'confirmed'), 0)::int as booked
         from public.slots s join public.events e on e.id = s.event_id
        where s.tenant_id = $1 and s.event_id = $2 and s.ends_at > now()
        order by s.starts_at`,
      [ctx.tenant.id, eventId],
    );
    return rows;
  });
  return rows.map((r) => {
    const f = formatSlot(r.starts_at, r.ends_at, ctx.tenant.timezone);
    return {
      id: r.id,
      startsAt: r.starts_at,
      weekdayShort: f.weekdayShort,
      date: f.date,
      time: f.time,
      location: r.location,
      capacity: r.capacity,
      booked: r.booked,
      free: Math.max(0, r.capacity - r.booked),
      pct: r.capacity ? Math.min(100, Math.round((r.booked / r.capacity) * 100)) : 100,
      level: slotLevel(r.status, r.capacity, r.booked),
    };
  });
}

export async function listSlotBookings(ctx: AdminContext, slotId: string): Promise<AdminBooking[]> {
  return withActor(ctx.actor, async (db) => {
    const { rows: d } = await db.query<{ d: string | null }>("select public.get_pipedrive_company_domain($1) as d", [ctx.tenant.id]);
    const domain = d[0]?.d ?? null;
    const { rows } = await db.query<{
      id: string;
      name: string;
      email: string;
      seats: number;
      extra_attendees: string[];
      organization_name: string | null;
      pipedrive_deal_id: string | null;
    }>(
      `select b.id, b.name, b.email, b.seats, b.extra_attendees, i.organization_name, i.pipedrive_deal_id::text
         from public.bookings b join public.invitations i on i.id = b.invitation_id
        where b.tenant_id = $1 and b.slot_id = $2 and b.status = 'confirmed'
        order by b.created_at`,
      [ctx.tenant.id, slotId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      organization: r.organization_name,
      seats: r.seats,
      extraAttendees: r.extra_attendees,
      dealUrl: dealUrl(domain, r.pipedrive_deal_id),
    }));
  });
}

/**
 * Teilnehmeranzahl (Kapazität) eines Termins setzen. Nicht unter die gebuchten Plätze
 * (Trigger in der DB -> TB:capacity_below_booked); Rechte per RLS (owner/admin).
 */
export async function setCapacity(ctx: AdminContext, slotId: string, capacity: number): Promise<void> {
  try {
    await withActor(ctx.actor, async (db) => {
      const res = await db.query("update public.slots set capacity = $3 where id = $1 and tenant_id = $2", [slotId, ctx.tenant.id, capacity]);
      // keine Zeile: Termin unbekannt oder keine Schreibrechte (RLS)
      if (res.rowCount === 0) throw new AdminError("forbidden");
    });
  } catch (err) {
    throw toAdminError(err);
  }
}

/** Termin einfügen (in der Transaktion des Aufrufers); Datum/Uhrzeit in der Mandanten-Zeitzone */
async function insertSlot(
  db: PoolClient,
  ctx: AdminContext,
  s: { eventId: string; date: string; from: string; to: string; capacity: number; location: string | null; open: boolean },
): Promise<string> {
  const { rows } = await db.query<{ id: string; in_past: boolean }>(
    `insert into public.slots (tenant_id, event_id, starts_at, ends_at, capacity, location, status)
     select $1, e.id, ($3::date + $4::time) at time zone $8, ($3::date + $5::time) at time zone $8, $6,
            nullif($7, e.location), $9::public.slot_status
       from public.events e where e.id = $2 and e.tenant_id = $1
     returning id, starts_at <= now() as in_past`,
    [ctx.tenant.id, s.eventId, s.date, s.from, s.to, s.capacity, s.location, ctx.tenant.timezone, s.open ? "open" : "closed"],
  );
  const row = rows[0];
  if (!row) throw new AdminError("not_found");
  // in der Vergangenheit: zurückrollen (Fehler beendet die Transaktion)
  if (row.in_past) throw new AdminError("slot_in_past");
  return row.id;
}

export async function createSlot(ctx: AdminContext, input: CreateSlotInput): Promise<string> {
  try {
    return await withActor(ctx.actor, (db) => insertSlot(db, ctx, input));
  } catch (err) {
    throw toAdminError(err);
  }
}

/** Neue (veröffentlichte) Veranstaltung mit erstem Termin – beides oder nichts; Rechte per RLS (owner/admin) */
export async function createEvent(ctx: AdminContext, input: CreateEventInput): Promise<{ eventId: string; slotId: string }> {
  try {
    return await withActor(ctx.actor, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into public.events (tenant_id, title, location, description, status) values ($1, $2, $3, $4, 'published') returning id`,
        [ctx.tenant.id, input.title, input.location, input.description],
      );
      const eventId = rows[0]!.id;
      // Ort des Termins = Ort der Veranstaltung (Termine können später abweichen)
      const slotId = await insertSlot(db, ctx, { eventId, date: input.date, from: input.from, to: input.to, capacity: input.capacity, location: null, open: true });
      return { eventId, slotId };
    });
  } catch (err) {
    throw toAdminError(err);
  }
}
