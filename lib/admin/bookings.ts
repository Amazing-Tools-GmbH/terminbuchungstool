import "server-only";
/**
 * Admin → Buchungen: alle Buchungen des Mandanten in einer Liste.
 * Läuft als angemeldeter Benutzer (RLS: Mitglieder lesen).
 */
import { withActor } from "@/lib/db";
import { formatSlot } from "@/lib/datetime";
import type { AdminContext } from "@/lib/auth/admin";
import { dealUrl } from "./slot-logic";

export const BOOKING_VIEWS = ["upcoming", "past", "cancelled"] as const;
export type BookingView = (typeof BOOKING_VIEWS)[number];

export type BookingListItem = {
  id: string;
  eventTitle: string;
  weekdayShort: string;
  date: string;
  time: string;
  location: string | null;
  seats: number;
  extraAttendees: string[];
  customer: string;
  email: string;
  organization: string | null;
  /** Mitarbeiter, der direkt gebucht hat; null = Kunde selbst */
  bookedBy: string | null;
  createdAt: Date;
  cancelledAt: Date | null;
  dealUrl: string | null;
};

const LIMIT = 500;

export async function listBookings(
  ctx: AdminContext,
  opts: { view: BookingView; eventId?: string | null },
): Promise<{ items: BookingListItem[]; truncated: boolean }> {
  return withActor(ctx.actor, async (db) => {
    const { rows: d } = await db.query<{ d: string | null }>("select public.get_pipedrive_company_domain($1) as d", [ctx.tenant.id]);
    const domain = d[0]?.d ?? null;
    const where =
      opts.view === "cancelled"
        ? "b.status = 'cancelled' and b.replaced_by is null"
        : opts.view === "past"
          ? "b.status = 'confirmed' and s.ends_at <= now()"
          : "b.status = 'confirmed' and s.ends_at > now()";
    const order = opts.view === "upcoming" ? "s.starts_at asc, b.created_at" : opts.view === "past" ? "s.starts_at desc" : "b.cancelled_at desc";
    const { rows } = await db.query<{
      id: string;
      title: string;
      starts_at: Date;
      ends_at: Date;
      location: string | null;
      seats: number;
      extra_attendees: string[];
      name: string;
      email: string;
      organization_name: string | null;
      booked_by_name: string | null;
      booked_by: string | null;
      created_at: Date;
      cancelled_at: Date | null;
      pipedrive_deal_id: string | null;
    }>(
      `select b.id, e.title, s.starts_at, s.ends_at, coalesce(s.location, e.location) as location,
              b.seats, b.extra_attendees, b.name, b.email, i.organization_name,
              b.booked_by, coalesce(m.display_name, m.email) as booked_by_name,
              b.created_at, b.cancelled_at, i.pipedrive_deal_id::text
         from public.bookings b
         join public.slots s       on s.id = b.slot_id
         join public.events e      on e.id = s.event_id
         join public.invitations i on i.id = b.invitation_id
         left join public.tenant_members m on m.tenant_id = b.tenant_id and m.user_id = b.booked_by
        where b.tenant_id = $1 and ${where}
          and ($2::uuid is null or e.id = $2)
        order by ${order}
        limit ${LIMIT + 1}`,
      [ctx.tenant.id, opts.eventId ?? null],
    );
    const tz = ctx.tenant.timezone;
    const items = rows.slice(0, LIMIT).map((r) => {
      const f = formatSlot(r.starts_at, r.ends_at, tz);
      return {
        id: r.id,
        eventTitle: r.title,
        weekdayShort: f.weekdayShort,
        date: f.date,
        time: f.time,
        location: r.location,
        seats: r.seats,
        extraAttendees: r.extra_attendees,
        customer: r.name,
        email: r.email,
        organization: r.organization_name,
        bookedBy: r.booked_by ? (r.booked_by_name ?? "—") : null,
        createdAt: r.created_at,
        cancelledAt: r.cancelled_at,
        dealUrl: dealUrl(domain, r.pipedrive_deal_id),
      };
    });
    return { items, truncated: rows.length > LIMIT };
  });
}
