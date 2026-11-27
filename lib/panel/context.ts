import "server-only";
/**
 * Daten des Vertriebs-Panels für einen Deal: Kontakt (aus Pipedrive),
 * Veranstaltungen mit kommenden Terminen und Belegung, letzte Einladung
 * dieses Deals mit Versand- und Buchungsstatus, persönlicher Link.
 * Zugriffe auf unsere Daten als angemeldeter Benutzer (RLS).
 */
import { headers } from "next/headers";
import { withActor, type DbActor } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto/secretbox";
import { formatSlot } from "@/lib/datetime";
import { panelSessionSchema, unseal, type PanelSession } from "@/lib/auth/session";
import { tenantForMember } from "@/lib/tenant/current";
import type { PublicTenant } from "@/lib/tenant/types";
import { pipedriveApiAccess, pipedriveCrm } from "@/lib/pipedrive/runtime";
import type { CrmPerson } from "@/lib/pipedrive/crm";

export type PanelSlot = { id: string; dayKey: string; weekdayShort: string; date: string; time: string; location: string | null; capacity: number; free: number };
export type PanelEvent = { id: string; title: string; slots: PanelSlot[] };
export type PanelInvitation = {
  id: string;
  createdAt: string;
  slotIds: string[] | null;
  link: string | null;
  mail: { status: "queued" | "sending" | "sent" | "failed"; code: string | null; channel: string | null } | null;
  booking: { date: string; time: string; seats: number } | null;
  status: "open" | "booked" | "cancelled" | "revoked";
  /** es gibt eine vom Team stornierte Buchung zu diesem Link */
  cancelledBooking: boolean;
  expired: boolean;
};
export type PanelContext = {
  tenantName: string;
  timezone: string;
  /** heutiges Datum (YYYY-MM-DD) in der Mandanten-Zeitzone */
  todayKey: string;
  /** null = Panel im Kontakt (ohne Deal) */
  deal: { id: number; title: string | null } | null;
  person: { name: string; email: string | null; organization: string | null } | null;
  events: PanelEvent[];
  invitation: PanelInvitation | null;
  totals: { free: number; capacity: number };
  /** Versandweg "eigenes Postfach", aber das Postfach des Mitarbeiters ist nicht aktiv */
  mailboxMissing: boolean;
};

const dayKeyOf = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/** Panel-Sitzung aus dem Authorization-Header + Mandant (nur aktive Mitglieder) */
export async function panelAuth(): Promise<{ s: PanelSession; actor: DbActor; tenant: PublicTenant } | null> {
  const h = (await headers()).get("authorization") ?? "";
  const s = unseal("panel", h.startsWith("Bearer ") ? h.slice(7) : null, panelSessionSchema);
  if (!s) return null;
  const tenant = await tenantForMember(s.uid, s.tid);
  return tenant ? { s, actor: { role: "authenticated", userId: s.uid }, tenant } : null;
}

/** Kontakt des Deals aus Pipedrive (Name/E-Mail nie aus dem Browser übernehmen) */
export async function dealContact(s: PanelSession) {
  const access = await pipedriveApiAccess(s.tid, s.uid);
  if (!access) return { deal: null, person: null as CrmPerson | null, organization: null as string | null };
  const crm = pipedriveCrm();
  if (!s.deal) {
    // Panel im Kontakt: Person direkt, Firma aus der Person
    const person = s.person ? await crm.getPerson(access, s.person) : null;
    const organization = person?.orgId ? await crm.getOrganizationName(access, person.orgId) : null;
    return { deal: null, person, organization };
  }
  const deal = await crm.getDeal(access, s.deal);
  const person = deal?.personId ? await crm.getPerson(access, deal.personId) : null;
  const organization = deal?.orgId ? await crm.getOrganizationName(access, deal.orgId) : null;
  return { deal, person, organization };
}

type InvitationRow = {
  id: string; created_at: Date; allowed_slot_ids: string[] | null; link_enc: string | null; status: PanelInvitation["status"]; expires_at: Date;
};

/** Jüngste Einladung zum aktuellen Kontakt des Deals (bzw. zur Person im Kontakt-Panel) – Grundlage für Anzeige und Absage */
export async function currentInvitation(
  db: { query: <R extends object>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> },
  tenantId: string,
  s: PanelSession,
  person: { id: number; email: string | null } | null,
): Promise<InvitationRow | null> {
  // Abgleich über die E-Mail-Adresse des aktuellen Kontakts (Deal: Kontakt des Deals,
  // Kontakt-Panel: die Person) – egal, in welchem Deal gebucht wurde. Wechselt der
  // Kontakt im Deal, erscheint die Buchung des alten Kontakts nicht mehr.
  // Reihenfolge: aktive Buchung (zuerst die dieses Deals), dann Einladungen dieses Deals,
  // dann die jüngste.
  const email = person?.email?.trim().toLowerCase() ?? "";
  if (!email) return null;
  const { rows } = await db.query<InvitationRow>(
    `select i.id, i.created_at, i.allowed_slot_ids, i.link_enc, i.status::text as status, i.expires_at from public.invitations i
      where i.tenant_id = $1 and lower(i.email) = $3
      order by exists (select 1 from public.bookings b where b.invitation_id = i.id and b.status = 'confirmed') desc,
               coalesce($2::bigint is not null and i.pipedrive_deal_id = $2, false) desc,
               i.created_at desc
      limit 1`,
    [tenantId, s.deal, email],
  );
  return rows[0] ?? null;
}

export async function loadPanelContext(s: PanelSession, actor: DbActor, tenant: PublicTenant): Promise<PanelContext> {
  const tz = tenant.timezone;
  // Kontakt zuerst: Einladung/Buchung gehören zum aktuellen Kontakt des Deals
  // (wird der Kontakt im Deal geändert, zeigt das Panel die alte Buchung nicht mehr)
  const { deal, person, organization } = await dealContact(s).catch(() => ({ deal: null, person: null, organization: null }));
  const [data] = await Promise.all([
    withActor(actor, async (db) => {
      const { rows: slots } = await db.query<{
        event_id: string; title: string; id: string; starts_at: Date; ends_at: Date; location: string | null; capacity: number; booked: number;
      }>(
        `select e.id as event_id, e.title, s.id, s.starts_at, s.ends_at, coalesce(s.location, e.location) as location, s.capacity,
                coalesce((select sum(b.seats) from public.bookings b where b.slot_id = s.id and b.status = 'confirmed'), 0)::int as booked
           from public.events e
           left join public.slots s on s.event_id = e.id and s.status = 'open' and s.starts_at > now()
          where e.tenant_id = $1 and e.status = 'published'
          order by e.created_at, s.starts_at`,
        [tenant.id],
      );
      const i = await currentInvitation(db, tenant.id, s, person);
      let booking: PanelInvitation["booking"] = null;
      let cancelledBooking = false;
      if (i) {
        const { rows: c } = await db.query("select 1 from public.bookings where invitation_id = $1 and status = 'cancelled' limit 1", [i.id]);
        cancelledBooking = c.length > 0;
        const { rows: b } = await db.query<{ starts_at: Date; ends_at: Date; seats: number }>(
          `select s.starts_at, s.ends_at, b.seats from public.bookings b join public.slots s on s.id = b.slot_id
            where b.invitation_id = $1 and b.status = 'confirmed' order by b.created_at desc limit 1`,
          [i.id],
        );
        if (b[0]) {
          const f = formatSlot(b[0].starts_at, b[0].ends_at, tz);
          booking = { date: `${f.weekdayShort}, ${f.date}`, time: f.time, seats: b[0].seats };
        }
      }
      const { rows: mb } = await db.query<{ missing: boolean }>(
        `select t.mail_route = 'employee' and not exists (
                  select 1 from public.mail_connections c
                   where c.tenant_id = t.id and c.scope = 'user' and c.user_id = $2 and c.status = 'active') as missing
           from public.tenants t where t.id = $1`,
        [tenant.id, s.uid],
      );
      return { slots, i, booking, cancelledBooking, mailboxMissing: mb[0]?.missing === true };
    }),
  ]);
  // Versandstatus der Einladungsmail (Outbox ist für sales nicht lesbar -> Server, nur für die eigene sichtbare Einladung)
  let mail: PanelInvitation["mail"] = null;
  if (data.i) {
    mail = await withActor({ role: "service_role" }, async (db) => {
      const { rows } = await db.query<{ status: "queued" | "sending" | "sent" | "failed"; error_code: string | null; send_channel: string | null }>(
        `select status::text as status, error_code, send_channel from public.email_outbox
          where tenant_id = $1 and type = 'invitation' and payload->>'invitation_id' = $2 order by created_at desc limit 1`,
        [tenant.id, data.i!.id],
      );
      const r = rows[0];
      return r ? { status: r.status, code: r.error_code, channel: r.send_channel } : null;
    });
  }

  const events = new Map<string, PanelEvent>();
  let free = 0;
  let capacity = 0;
  for (const r of data.slots) {
    const ev = events.get(r.event_id) ?? { id: r.event_id, title: r.title, slots: [] };
    events.set(r.event_id, ev);
    if (!r.id) continue;
    const f = formatSlot(r.starts_at, r.ends_at, tz);
    const slotFree = Math.max(0, r.capacity - r.booked);
    free += slotFree;
    capacity += r.capacity;
    const dayKey = dayKeyOf(r.starts_at, tz);
    ev.slots.push({ id: r.id, dayKey, weekdayShort: f.weekdayShort, date: f.date, time: f.time, location: r.location, capacity: r.capacity, free: slotFree });
  }

  let link: string | null = null;
  if (data.i?.link_enc) {
    try {
      link = decryptSecret(data.i.link_enc);
    } catch {
      link = null;
    }
  }

  return {
    tenantName: tenant.name,
    timezone: tz,
    todayKey: dayKeyOf(new Date(), tz),
    deal: s.deal ? { id: s.deal, title: deal?.title ?? null } : null,
    person: person ? { name: person.name, email: person.email, organization } : null,
    events: [...events.values()],
    invitation: data.i
      ? {
          id: data.i.id,
          createdAt: data.i.created_at.toISOString(),
          slotIds: data.i.allowed_slot_ids,
          link,
          mail,
          booking: data.booking,
          status: data.i.status,
          cancelledBooking: data.cancelledBooking,
          expired: data.i.expires_at.getTime() < Date.now(),
        }
      : null,
    totals: { free, capacity },
    mailboxMissing: data.mailboxMissing,
  };
}
