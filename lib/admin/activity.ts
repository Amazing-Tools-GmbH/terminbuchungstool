import "server-only";
/**
 * Admin → Verlauf: Vorgänge (Einladung bzw. Direktbuchung) mit ihren
 * Schritten. Rohdaten aus public.activity_runs/activity_items (owner/admin),
 * Texte hier. Reine Aufbereitung in buildSteps() (testbar).
 */
import { withActor } from "@/lib/db";
import type { AdminContext } from "@/lib/auth/admin";
import { formatDateTime, formatSlot } from "@/lib/datetime";
import { at, mailErrorText } from "@/lib/texts/admin";
import { AdminError, toAdminError } from "./errors";
import { dealUrl } from "./slot-logic";

export type StepStatus = "ok" | "pending" | "error";
export type Step = {
  at: Date;
  status: StepStatus;
  text: string;
  /** Zusatz: Kanal, Versuche, Fehlermeldung */
  note: string | null;
  retry: { source: "mail" | "pipedrive"; id: string } | null;
};
export type Run = {
  invitationId: string;
  eventTitle: string;
  customer: string;
  email: string;
  organization: string | null;
  dealUrl: string | null;
  direct: boolean;
  lastAt: Date;
  status: StepStatus;
  steps: Step[];
};

export type ActivityItem = {
  invitation_id: string;
  at: Date;
  source: "invitation" | "booking" | "guest" | "team" | "mail" | "pipedrive";
  kind: string;
  status: string;
  ref: string;
  detail: Record<string, unknown>;
};

const PAGE = 30;

export async function loadActivity(
  ctx: AdminContext,
  opts: { onlyErrors: boolean; eventId: string | null; page: number; invitationId?: string | null },
): Promise<{ runs: Run[]; hasMore: boolean }> {
  if (ctx.role === "sales") throw new AdminError("forbidden");
  try {
    return await withActor(ctx.actor, async (db) => {
      const { rows: d } = await db.query<{ d: string | null }>("select public.get_pipedrive_company_domain($1) as d", [ctx.tenant.id]);
      const domain = d[0]?.d ?? null;
      const { rows } = await db.query<{
        invitation_id: string;
        event_title: string;
        name: string;
        email: string;
        organization_name: string | null;
        deal_id: string | null;
        direct: boolean;
        last_at: Date;
        failed: number;
        pending: number;
      }>("select * from public.activity_runs($1, $2, $3, $4, $5, $6)", [
        ctx.tenant.id,
        opts.onlyErrors,
        opts.eventId,
        PAGE + 1,
        opts.page * PAGE,
        opts.invitationId ?? null,
      ]);
      const page = rows.slice(0, PAGE);
      const { rows: items } = page.length
        ? await db.query<ActivityItem>("select * from public.activity_items($1, $2)", [ctx.tenant.id, page.map((r) => r.invitation_id)])
        : { rows: [] as ActivityItem[] };
      const tz = ctx.tenant.timezone;
      return {
        hasMore: rows.length > PAGE,
        runs: page.map((r) => ({
          invitationId: r.invitation_id,
          eventTitle: r.event_title,
          customer: r.name,
          email: r.email,
          organization: r.organization_name,
          dealUrl: dealUrl(domain, r.deal_id),
          direct: r.direct,
          lastAt: r.last_at,
          status: r.failed > 0 ? "error" : r.pending > 0 ? "pending" : "ok",
          steps: buildSteps(
            items.filter((i) => i.invitation_id === r.invitation_id),
            tz,
          ),
        })),
      };
    });
  } catch (err) {
    throw toAdminError(err);
  }
}

export async function retryActivity(ctx: AdminContext, source: "mail" | "pipedrive", id: string): Promise<boolean> {
  if (ctx.role === "sales") throw new AdminError("forbidden");
  try {
    return await withActor(ctx.actor, async (db) => {
      const { rows } = await db.query<{ ok: boolean }>("select public.activity_retry($1, $2, $3) as ok", [ctx.tenant.id, source, id]);
      return rows[0]!.ok;
    });
  } catch (err) {
    throw toAdminError(err);
  }
}

/** Anzahl Fehler der letzten 7 Tage (0 für sales) – für den Hinweis im Admin */
export async function activityProblemCount(ctx: AdminContext): Promise<number> {
  if (ctx.role === "sales") return 0;
  try {
    return await withActor(ctx.actor, async (db) => {
      const { rows } = await db.query<{ n: number }>("select public.activity_problem_count($1) as n", [ctx.tenant.id]);
      return rows[0]?.n ?? 0;
    });
  } catch {
    return 0;
  }
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));

/** Rohdaten -> lesbare Schritte (chronologisch) */
export function buildSteps(items: ActivityItem[], tz: string): Step[] {
  const persons = (n: number) => (n === 1 ? "1 Person" : `${n} Personen`);
  const when = (s: unknown, e: unknown) => {
    if (!s || !e) return "—";
    const f = formatSlot(new Date(String(s)), new Date(String(e)), tz);
    return `${f.weekdayShort}, ${f.date}, ${f.time}`;
  };
  const steps: Step[] = [];
  for (const i of items) {
    const d = i.detail ?? {};
    const by = str(d.by);
    const base = { at: new Date(i.at), retry: null, note: null as string | null };
    switch (i.source) {
      case "invitation":
        if (i.kind === "link_created") steps.push({ ...base, status: "ok", text: by ? at("activity.step.link_createdBy", { by }) : at("activity.step.link_created") });
        break;
      case "booking": {
        if (i.kind === "cancelled") {
          steps.push({ ...base, status: "ok", text: d.by_team ? at("activity.step.cancelledTeam", { by: by ?? "—" }) : at("activity.step.cancelledCustomer") });
          break;
        }
        const text = at(i.kind === "rebooked" ? "activity.step.rebooked" : "activity.step.booked", {
          date: when(d.starts_at, d.ends_at),
          persons: persons(num(d.seats)),
        });
        steps.push({ ...base, status: "ok", text, note: by ? at("activity.step.byTeam", { by }) : at("activity.step.byCustomer") });
        break;
      }
      case "guest":
        steps.push({ ...base, status: "ok", text: at("activity.step.guestDeclined", { name: str(d.name) ?? "—" }), note: str(d.email) });
        break;
      case "team":
        steps.push({
          ...base,
          status: "ok",
          text: at("activity.step.slotChanged", { by: by ?? "—", from: when(d.old_starts_at, d.old_ends_at), to: when(d.starts_at, d.ends_at) }),
          note: d.location !== d.old_location && str(d.location) ? at("activity.step.slotLocation", { location: str(d.location)! }) : null,
        });
        break;
      case "mail": {
        const to = str(d.to) ?? "—";
        const key =
          i.kind === "invitation"
            ? "activity.mail.invitation"
            : i.kind === "cancellation"
              ? d.guest
                ? "activity.mail.guestCancellation"
                : "activity.mail.cancellation"
              : d.guest
                ? d.by_organizer || d.changed
                  ? "activity.mail.guestChanged"
                  : "activity.mail.guestInvite"
                : str(d.guest_cancelled)
                  ? "activity.mail.guestNotice"
                  : d.changed || d.by_organizer
                    ? "activity.mail.changed"
                    : "activity.mail.confirmation";
        const status: StepStatus = i.status === "sent" ? "ok" : i.status === "failed" ? "error" : "pending";
        const error = str(d.error_code) ? mailErrorText(str(d.error_code)) : str(d.error);
        const channel = str(d.channel) ? at(`activity.channel.${str(d.channel)}` as never) : null;
        const notes = [
          channel && !channel.startsWith("activity.") ? channel : null,
          status === "error" ? [at("activity.state.failed"), at("activity.state.attempts", { n: num(d.attempts) }), error].filter(Boolean).join(" – ") : null,
          status === "pending" ? [at("activity.state.queued"), error ? at("activity.state.lastError", { error }) : null].filter(Boolean).join(" – ") : null,
        ].filter(Boolean);
        steps.push({
          ...base,
          at: status === "ok" && str(d.sent_at) ? new Date(String(d.sent_at)) : base.at,
          status,
          text: at(key, { to, name: str(d.guest_cancelled) ?? "" }),
          note: notes.join(" · ") || null,
          retry: status === "error" ? { source: "mail", id: i.ref } : null,
        });
        break;
      }
      case "pipedrive": {
        const status: StepStatus = i.status === "done" ? "ok" : i.status === "failed" ? "error" : "pending";
        const key = `activity.pd.${i.kind}`;
        const error = str(d.error);
        steps.push({
          ...base,
          at: status === "ok" && str(d.done_at) ? new Date(String(d.done_at)) : base.at,
          status,
          text: ["invitation_note", "booking_activity", "cancel_activity"].includes(i.kind) ? at(key as never) : i.kind,
          note:
            status === "error"
              ? [at("activity.state.failed"), at("activity.state.attempts", { n: num(d.attempts) }), error?.slice(0, 200)].filter(Boolean).join(" – ")
              : status === "pending"
                ? [at("activity.state.queued"), error ? at("activity.state.lastError", { error: error.slice(0, 200) }) : null].filter(Boolean).join(" – ")
                : null,
          retry: status === "error" ? { source: "pipedrive", id: i.ref } : null,
        });
        break;
      }
    }
  }
  return steps.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export function formatAt(d: Date, tz: string): string {
  return formatDateTime(d, tz);
}
