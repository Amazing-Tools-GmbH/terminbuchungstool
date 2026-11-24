import Link from "next/link";
import { requireAdmin } from "@/lib/auth/admin";
import { flashMessages } from "@/lib/admin/messages";
import { formatAt, loadActivity, type StepStatus } from "@/lib/admin/activity";
import { listEvents } from "@/lib/admin/slots";
import { at } from "@/lib/texts/admin";
import styles from "@/components/admin/Admin.module.css";
import { retryAction } from "./actions";

type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ICON: Record<StepStatus, string> = { ok: "✓", pending: "⏳", error: "✗" };
const LEVEL: Record<StepStatus, string> = { ok: "lvl_ok", pending: "lvl_low", error: "lvl_full" };

export default async function ActivityPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const sp = await searchParams;
  const { ok, error } = flashMessages(sp);
  const onlyErrors = one(sp.errors) === "1";
  const eventId = UUID.test(one(sp.event) ?? "") ? one(sp.event)! : null;
  const invitationId = UUID.test(one(sp.inv) ?? "") ? one(sp.inv)! : null;
  const page = Math.max(0, Math.min(1000, Number(one(sp.page) ?? 0) || 0));
  const [events, { runs, hasMore }] = await Promise.all([listEvents(ctx), loadActivity(ctx, { onlyErrors, eventId, page, invitationId })]);
  const tz = ctx.tenant.timezone;
  const query = (over: Record<string, string | null>) => {
    const q = new URLSearchParams();
    const base: Record<string, string | null> = { errors: onlyErrors ? "1" : null, event: eventId, page: page ? String(page) : null, ...over };
    for (const [k, v] of Object.entries(base)) if (v) q.set(k, v);
    return `/admin/verlauf${q.size ? `?${q}` : ""}`;
  };
  const self = query({ inv: invitationId });

  return (
    <>
      <h1 className={styles.h1}>{at("activity.title")}</h1>
      <p className={styles.muted} style={{ margin: 0 }}>
        {at("activity.intro")}
      </p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {ok && (
        <p role="status" className={styles.notice}>
          {ok}
        </p>
      )}

      <form method="get" className={styles.filterBar}>
        <label className={styles.check}>
          <input type="checkbox" name="errors" value="1" defaultChecked={onlyErrors} /> {at("activity.onlyErrors")}
        </label>
        <span className={styles.inlineForm} style={{ marginTop: 0 }}>
          <label htmlFor="act-event" className={styles.visuallyHidden}>
            {at("bookingList.event")}
          </label>
          <select id="act-event" name="event" defaultValue={eventId ?? ""} className={styles.inlineSelect}>
            <option value="">{at("activity.allEvents")}</option>
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </select>
          <button type="submit" className={styles.btnGhost}>
            {at("activity.filter")}
          </button>
        </span>
      </form>

      {runs.length === 0 ? (
        <p className={`${styles.card} ${styles.muted}`}>{at("activity.empty")}</p>
      ) : (
        <div className={styles.runs}>
          {runs.map((r) => (
            <details key={r.invitationId} className={styles.run} open={!!invitationId || r.status === "error"} id={`run-${r.invitationId}`}>
              <summary className={styles.runHead}>
                <span className={`${styles.badge} ${styles[LEVEL[r.status]]}`}>
                  <span aria-hidden="true">{ICON[r.status]}</span> {at(`activity.status.${r.status}`)}
                </span>
                <span className={styles.runTitle}>
                  <strong>{r.organization ?? r.customer}</strong>
                  <span className={styles.hint}>
                    {r.organization ? `${r.customer} · ` : ""}
                    {r.eventTitle} · {at(r.direct ? "activity.run.direct" : "activity.run.link")}
                  </span>
                </span>
                <span className={`${styles.hint} ${styles.nowrap}`}>{at("activity.run.last", { at: formatAt(r.lastAt, tz) })}</span>
              </summary>
              <ol className={styles.steps}>
                {r.steps.map((s, n) => (
                  <li key={n} className={styles.step} data-status={s.status}>
                    <span className={styles.stepIcon} aria-label={at(`activity.status.${s.status}`)}>
                      {ICON[s.status]}
                    </span>
                    <span className={styles.stepBody}>
                      <span>{s.text}</span>
                      {s.note && <span className={styles.hint}>{s.note}</span>}
                    </span>
                    <span className={`${styles.hint} ${styles.nowrap}`}>{formatAt(s.at, tz)}</span>
                    {s.retry && (
                      <form action={retryAction}>
                        <input type="hidden" name="source" value={s.retry.source} />
                        <input type="hidden" name="id" value={s.retry.id} />
                        <input type="hidden" name="back" value={`${self}#run-${r.invitationId}`} />
                        <button type="submit" className={styles.btnGhost}>
                          {at("activity.retry")}
                        </button>
                      </form>
                    )}
                  </li>
                ))}
              </ol>
              {r.dealUrl && (
                <p className={styles.hint} style={{ margin: "8px 0 0" }}>
                  <a href={r.dealUrl} target="_blank" rel="noopener noreferrer">
                    {at("activity.deal")}
                  </a>
                </p>
              )}
            </details>
          ))}
        </div>
      )}

      {!invitationId && (page > 0 || hasMore) && (
        <div className={styles.actions}>
          {page > 0 && (
            <Link className={styles.btnGhost} href={query({ page: page > 1 ? String(page - 1) : null })}>
              {at("activity.newer")}
            </Link>
          )}
          {hasMore && (
            <Link className={styles.btnGhost} href={query({ page: String(page + 1) })}>
              {at("activity.more")}
            </Link>
          )}
        </div>
      )}
    </>
  );
}
