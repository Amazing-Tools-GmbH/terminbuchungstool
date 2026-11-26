/**
 * Aufträge an Pipedrive (public.pipedrive_jobs), Verarbeitung wie die Mail-
 * Outbox: SKIP LOCKED, Wiederholung mit Backoff, nach MAX_ATTEMPTS failed.
 * Eine Buchung scheitert nie an Pipedrive – Fehler landen nur hier.
 *
 *   booking_activity  Aktivität im Deal anlegen bzw. bei Umbuchung aktualisieren
 *                     (Eigentümer = einladender Mitarbeiter)
 *   cancel_activity   Aktivität löschen + Notiz "storniert"
 *   invitation_note   Notiz "Link gesendet" (wenn die Mail nicht über Pipedrive ging)
 *
 * Zugang: bevorzugt der des einladenden Mitarbeiters, sonst der aus der Installation.
 */
import type pg from "pg";
import { withActorOn } from "@/lib/db/actor";
import { escapeHtml } from "@/lib/mail/templates";
import { formatSlot } from "@/lib/datetime";
import { at } from "@/lib/texts/admin";
import type { PipedriveApiAccess, PipedriveCrm } from "./crm";
import { PipedriveError } from "./client";

export const PD_MAX_ATTEMPTS = 6;
const BACKOFF_MINUTES = [1, 5, 15, 60, 240, 720];
const STALE_LOCK_MINUTES = 10;

export type PdJobDeps = {
  crm: PipedriveCrm;
  /** Zugang für den Mandanten; userId = einladender Mitarbeiter (bevorzugt) */
  access: (tenantId: string, userId: string | null) => Promise<PipedriveApiAccess | null>;
};

type JobRow = { id: string; tenant_id: string; type: "booking_activity" | "cancel_activity" | "invitation_note" | "link_contact"; payload: Record<string, unknown>; attempts: number };
export type PdJobResult = { done: number; requeued: number; failed: number };

const asService = <T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>) => withActorOn(pool, { role: "service_role" }, fn);

export async function processPipedriveJobs(pool: pg.Pool, deps: PdJobDeps, opts: { limit?: number; tenantId?: string } = {}): Promise<PdJobResult> {
  const rows = await asService(pool, async (c) => {
    const { rows } = await c.query<JobRow>(
      `update public.pipedrive_jobs j
          set status = 'sending', locked_at = now(), attempts = j.attempts + 1
        where j.id in (
          select id from public.pipedrive_jobs
           where ((status = 'queued' and next_attempt_at <= now())
              or (status = 'sending' and locked_at < now() - make_interval(mins => $2)))
             and ($3::uuid is null or tenant_id = $3)
           order by created_at
           limit $1
           for update skip locked)
        returning id, tenant_id, type, payload, attempts`,
      [opts.limit ?? 20, STALE_LOCK_MINUTES, opts.tenantId ?? null],
    );
    return rows;
  });
  const result: PdJobResult = { done: 0, requeued: 0, failed: 0 };
  for (const job of rows) {
    try {
      await runJob(pool, deps, job);
      await asService(pool, (c) => c.query("update public.pipedrive_jobs set status = 'done', done_at = now(), locked_at = null, last_error = null where id = $1", [job.id]));
      result.done++;
    } catch (err) {
      const e = err as PipedriveError | Error;
      const permanent = (e instanceof PipedriveError && e.status !== undefined && e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 401) || job.attempts >= PD_MAX_ATTEMPTS || e.message.startsWith("TB:");
      if (permanent) {
        await asService(pool, (c) => c.query("update public.pipedrive_jobs set status = 'failed', locked_at = null, last_error = $2 where id = $1", [job.id, e.message]));
        result.failed++;
      } else {
        const wait = BACKOFF_MINUTES[Math.min(job.attempts - 1, BACKOFF_MINUTES.length - 1)]!;
        await asService(pool, (c) =>
          c.query(
            "update public.pipedrive_jobs set status = 'queued', locked_at = null, last_error = $2, next_attempt_at = now() + make_interval(mins => $3) where id = $1",
            [job.id, e.message, wait],
          ),
        );
        result.requeued++;
      }
    }
  }
  return result;
}

type BookingInfo = {
  id: string;
  name: string;
  email: string;
  seats: number;
  extra_attendees: string[];
  pipedrive_activity_id: string | null;
  starts_at: Date;
  ends_at: Date;
  location: string | null;
  event_title: string;
  deal_id: string | null;
  person_id: string | null;
  created_by: string | null;
  owner_pd_id: string | null;
  timezone: string;
  prev_activity_id: string | null;
  activity_type: string;
  guests: { name: string; email: string }[] | null;
};

async function loadBooking(pool: pg.Pool, tenantId: string, bookingId: string): Promise<BookingInfo | null> {
  return asService(pool, async (c) => {
    const { rows } = await c.query<BookingInfo>(
      `select b.id, b.name, b.email, b.seats, b.extra_attendees, b.pipedrive_activity_id::text,
              s.starts_at, s.ends_at, coalesce(s.location, e.location) as location, e.title as event_title,
              i.pipedrive_deal_id::text as deal_id, i.pipedrive_person_id::text as person_id, i.created_by,
              m.pipedrive_user_id::text as owner_pd_id, t.timezone, t.pd_activity_type as activity_type,
              (select jsonb_agg(jsonb_build_object('name', g.name, 'email', g.email) order by g.created_at)
                 from public.booking_guests g where g.booking_id = b.id and g.status = 'confirmed') as guests,
              (select p.pipedrive_activity_id::text from public.bookings p
                where p.replaced_by = b.id and p.pipedrive_activity_id is not null limit 1) as prev_activity_id
         from public.bookings b
         join public.slots s on s.id = b.slot_id
         join public.events e on e.id = s.event_id
         join public.invitations i on i.id = b.invitation_id
         join public.tenants t on t.id = b.tenant_id
         left join public.tenant_members m on m.tenant_id = b.tenant_id and m.user_id = i.created_by
        where b.id = $1 and b.tenant_id = $2`,
      [bookingId, tenantId],
    );
    return rows[0] ?? null;
  });
}

async function accessFor(deps: PdJobDeps, tenantId: string, userId: string | null): Promise<PipedriveApiAccess> {
  const a = await deps.access(tenantId, userId);
  if (!a) throw new Error("TB:pipedrive_not_connected");
  return a;
}

async function runJob(pool: pg.Pool, deps: PdJobDeps, job: JobRow): Promise<void> {
  if (job.type === "invitation_note") {
    const inv = await asService(pool, async (c) => {
      const { rows } = await c.query<{ name: string; deal_id: string | null; person_id: string | null; created_by: string | null; slot_ids: string[] | null; timezone: string }>(
        `select i.name, i.pipedrive_deal_id::text as deal_id, i.pipedrive_person_id::text as person_id, i.created_by,
                i.allowed_slot_ids as slot_ids, t.timezone
           from public.invitations i join public.tenants t on t.id = i.tenant_id
          where i.id = $1 and i.tenant_id = $2`,
        [job.payload.invitation_id, job.tenant_id],
      );
      const r = rows[0];
      // ohne Deal und ohne Kontakt (z. B. öffentlicher Link vor dem Anlegen) nichts zu tun
      if (!r?.deal_id && !r?.person_id) return null;
      const { rows: slots } = r.slot_ids?.length
        ? await c.query<{ starts_at: Date; ends_at: Date }>("select starts_at, ends_at from public.slots where id = any($1::uuid[]) order by starts_at", [r.slot_ids])
        : { rows: [] };
      return { ...r, slots };
    });
    if (!inv) return;
    const offer = inv.slots.length
      ? inv.slots.map((s) => { const f = formatSlot(s.starts_at, s.ends_at, inv.timezone); return `${f.weekdayShort}, ${f.date}, ${f.time}`; }).join("; ")
      : at("pd.note.offerAll");
    const access = await accessFor(deps, job.tenant_id, inv.created_by);
    await deps.crm.addNote(access, {
      dealId: inv.deal_id ? Number(inv.deal_id) : null,
      personId: inv.person_id ? Number(inv.person_id) : null,
      html: `<p>${escapeHtml(at("pd.note.invited", { name: inv.name, offer }))}</p>`,
    });
    return;
  }

  if (job.type === "link_contact") {
    await linkContact(pool, deps, job);
    return;
  }

  const b = await loadBooking(pool, job.tenant_id, String(job.payload.booking_id ?? ""));
  // Einträge am Deal bzw. – ohne Deal – am Kontakt
  if (!b?.deal_id && !b?.person_id) return;
  const access = await accessFor(deps, job.tenant_id, b.created_by);

  if (job.type === "booking_activity") {
    const minutes = Math.max(15, Math.round((new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime()) / 60000));
    const lines = [
      at("pd.activity.note", { name: b.name, email: b.email }),
      ...(b.extra_attendees?.length ? [at("pd.activity.extra", { names: b.extra_attendees.join(", ") })] : []),
      ...(b.location ? [at("pd.activity.location", { location: b.location })] : []),
    ];
    const personId = b.person_id ? Number(b.person_id) : null;
    // ohne einladenden Mitarbeiter (öffentlicher Link): Besitzer des Deals
    let ownerId = b.owner_pd_id ? Number(b.owner_pd_id) : null;
    if (!ownerId && b.deal_id) ownerId = (await deps.crm.getDeal(access, Number(b.deal_id)).catch(() => null))?.ownerId ?? null;
    const input = {
      subject: at("pd.activity.subject", { event: b.event_title, seats: b.seats }),
      type: b.activity_type,
      // Kunde (mit Kontakt verknüpft) und weitere Teilnehmer mit E-Mail als Gäste
      attendees: [
        { email: b.email, name: b.name, personId },
        ...(b.guests ?? []).map((g) => ({ email: g.email, name: g.name, personId: null })),
      ],
      ownerId,
      dealId: b.deal_id ? Number(b.deal_id) : null,
      personId,
      start: new Date(b.starts_at),
      durationMinutes: minutes,
      note: lines.map((l) => `<p>${escapeHtml(l)}</p>`).join(""),
    };
    let activityId: number;
    const existing = b.pipedrive_activity_id ?? b.prev_activity_id;
    if (existing) {
      try {
        await deps.crm.updateActivity(access, Number(existing), input);
        activityId = Number(existing);
      } catch (err) {
        // in Pipedrive gelöscht -> neu anlegen
        if (err instanceof PipedriveError && err.status === 404) activityId = await deps.crm.createActivity(access, input);
        else throw err;
      }
    } else {
      activityId = await deps.crm.createActivity(access, input);
    }
    await asService(pool, (c) => c.query("update public.bookings set pipedrive_activity_id = $2 where id = $1", [b.id, activityId]));
    return;
  }

  // cancel_activity
  if (b.pipedrive_activity_id) {
    await deps.crm.deleteActivity(access, Number(b.pipedrive_activity_id));
    await asService(pool, (c) => c.query("update public.bookings set pipedrive_activity_id = null where id = $1", [b.id]));
  }
  const f = formatSlot(b.starts_at, b.ends_at, b.timezone);
  await deps.crm.addNote(access, {
    dealId: b.deal_id ? Number(b.deal_id) : null,
    personId: b.person_id ? Number(b.person_id) : null,
    html: `<p>${escapeHtml(at("pd.note.cancelled", { event: b.event_title, date: `${f.date}, ${f.time}`, seats: b.seats }))}</p>`,
  });
}

/**
 * Öffentlicher Event-Link: Kontakt und Deal in Pipedrive zuordnen
 * (Dublettencheck per E-Mail), sonst anlegen; danach die Aktivität.
 *   1. Kontakt mit dieser E-Mail?  ja -> nehmen; nein -> anlegen (mit Firma)
 *   2. offener Deal des Kontakts?  ja -> nehmen; nein -> anlegen
 *      (Pipeline/Phase aus tenants.new_deal_*, sonst Standard von Pipedrive)
 *   3. Einladung verknüpfen, Auftrag booking_activity
 * Braucht in Pipedrive das Recht, Kontakte anzulegen (Scope contacts:full).
 */
async function linkContact(pool: pg.Pool, deps: PdJobDeps, job: JobRow): Promise<void> {
  const r = await asService(pool, async (c) => {
    const { rows } = await c.query<{
      invitation_id: string;
      name: string;
      email: string;
      organization_name: string | null;
      deal_id: string | null;
      person_id: string | null;
      event_title: string;
      pipeline_id: string | null;
      stage_id: string | null;
      status: string;
    }>(
      `select i.id as invitation_id, b.name, b.email, i.organization_name, i.pipedrive_deal_id::text as deal_id,
              i.pipedrive_person_id::text as person_id, e.title as event_title,
              t.new_deal_pipeline_id::text as pipeline_id, t.new_deal_stage_id::text as stage_id, b.status::text as status
         from public.bookings b
         join public.invitations i on i.id = b.invitation_id
         join public.events e on e.id = i.event_id
         join public.tenants t on t.id = b.tenant_id
        where b.id = $1 and b.tenant_id = $2`,
      [job.payload.booking_id, job.tenant_id],
    );
    return rows[0] ?? null;
  });
  if (!r || r.status !== "confirmed") return; // inzwischen storniert: nichts anlegen
  if (r.deal_id || r.person_id) {
    // schon zugeordnet (erneuter Versuch): nur noch die Aktivität
    await queueActivity(pool, job);
    return;
  }
  const access = await accessFor(deps, job.tenant_id, null);
  const crm = deps.crm;

  let person = await crm.findPersonByEmail(access, r.email);
  let orgId: number | null = person?.orgId ?? null;
  if (!person) {
    if (r.organization_name) orgId = (await crm.findOrganization(access, r.organization_name)) ?? (await crm.createOrganization(access, r.organization_name));
    const id = await crm.createPerson(access, { name: r.name, email: r.email, orgId });
    person = { id, name: r.name, email: r.email, orgId };
  }
  const deal =
    (await crm.findOpenDeal(access, person.id)) ??
    (await crm.createDeal(access, {
      title: at("pd.deal.title", { name: r.organization_name ?? r.name, event: r.event_title }),
      personId: person.id,
      orgId,
      pipelineId: r.pipeline_id ? Number(r.pipeline_id) : null,
      stageId: r.stage_id ? Number(r.stage_id) : null,
    }));

  await asService(pool, (c) =>
    c.query("update public.invitations set pipedrive_person_id = $2, pipedrive_deal_id = $3 where id = $1", [r.invitation_id, person.id, deal.id]),
  );
  await queueActivity(pool, job);
}

async function queueActivity(pool: pg.Pool, job: JobRow) {
  await asService(pool, (c) =>
    c.query("insert into public.pipedrive_jobs (tenant_id, type, payload) values ($1, 'booking_activity', $2)", [
      job.tenant_id,
      { booking_id: job.payload.booking_id },
    ]),
  );
}
