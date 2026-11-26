import Link from "next/link";
import { requireAdmin } from "@/lib/auth/admin";
import { DASHBOARD_RANGES, loadDashboard, type DashboardRange } from "@/lib/admin/dashboard";
import { at } from "@/lib/texts/admin";
import styles from "@/components/admin/Admin.module.css";

type Search = Promise<Record<string, string | string[] | undefined>>;

function Bar({ pct, level }: { pct: number; level: string }) {
  return (
    <div className={styles.bar} aria-hidden="true">
      <span className={styles[`fill_${level}`]} style={{ width: `${pct}%` }} />
    </div>
  );
}

const levelFor = (pct: number) => (pct >= 100 ? "full" : pct >= 80 ? "low" : "ok");

/** Übersicht: Auslastung der Termine (alle Rollen) */
export default async function DashboardPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireAdmin();
  const sp = await searchParams;
  const raw = Array.isArray(sp.range) ? sp.range[0] : sp.range;
  const range: DashboardRange = (DASHBOARD_RANGES as readonly string[]).includes(raw ?? "") ? (raw as DashboardRange) : "30";
  const { totals, byEvent, slots } = await loadDashboard(ctx, range);

  return (
    <>
      <div className={styles.headRow}>
        <div>
          <h1 className={styles.h1}>{at("dashboard.title")}</h1>
          <p className={styles.muted} style={{ margin: "4px 0 0" }}>
            {at("dashboard.intro")}
          </p>
        </div>
        <nav className={styles.tabs} aria-label={at("dashboard.range")}>
          {DASHBOARD_RANGES.map((r) => (
            <Link key={r} href={`/admin/uebersicht?range=${r}`} className={styles.tab} aria-current={r === range ? "page" : undefined}>
              {at(`dashboard.range.${r}`)}
            </Link>
          ))}
        </nav>
      </div>

      <dl className={styles.kpis}>
        <div className={styles.kpi}>
          <dt>{at("dashboard.kpi.slots")}</dt>
          <dd>{totals.slots}</dd>
        </div>
        <div className={styles.kpi}>
          <dt>{at("dashboard.kpi.booked")}</dt>
          <dd>
            {totals.booked} / {totals.capacity}
          </dd>
        </div>
        <div className={styles.kpi}>
          <dt>{at("dashboard.kpi.pct")}</dt>
          <dd>{totals.pct} %</dd>
        </div>
        <div className={styles.kpi}>
          <dt>{at("dashboard.kpi.full")}</dt>
          <dd>{totals.full}</dd>
        </div>
      </dl>

      {slots.length === 0 ? (
        <p className={styles.card}>{at("dashboard.empty")}</p>
      ) : (
        <>
          <section aria-labelledby="dash-events">
            <h2 className={styles.h2} id="dash-events">
              {at("dashboard.byEvent")}
            </h2>
            <div className={styles.tableCard}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">{at("dashboard.col.event")}</th>
                    <th scope="col">{at("dashboard.col.slots")}</th>
                    <th scope="col">{at("dashboard.col.load")}</th>
                    <th scope="col">{at("dashboard.col.full")}</th>
                  </tr>
                </thead>
                <tbody>
                  {byEvent.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <Link href={`/admin?event=${e.id}#event-${e.id}`}>{e.title}</Link>
                      </td>
                      <td data-label={at("dashboard.col.slots")}>{e.slots}</td>
                      <td data-label={at("dashboard.col.load")}>
                        {e.booked} / {e.capacity} · {e.pct} %
                        <Bar pct={e.pct} level={levelFor(e.pct)} />
                      </td>
                      <td data-label={at("dashboard.col.full")}>{e.full}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="dash-slots">
            <h2 className={styles.h2} id="dash-slots">
              {at("dashboard.slots")}
            </h2>
            <div className={styles.tableCard}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">{at("dashboard.col.date")}</th>
                    <th scope="col">{at("dashboard.col.event")}</th>
                    <th scope="col">{at("dashboard.col.load")}</th>
                    <th scope="col">{at("dashboard.col.free")}</th>
                  </tr>
                </thead>
                <tbody>
                  {slots.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <Link href={`/admin?event=${s.eventId}&slot=${s.id}#event-${s.eventId}`}>
                          <strong>
                            {s.weekdayShort}, {s.date}
                          </strong>
                        </Link>
                        <div className={styles.hint}>
                          {s.time}
                          {s.location ? ` · ${s.location}` : ""}
                        </div>
                      </td>
                      <td data-label={at("dashboard.col.event")}>{s.eventTitle}</td>
                      <td data-label={at("dashboard.col.load")}>
                        {s.booked} / {s.capacity} · {s.pct} %
                        <Bar pct={s.pct} level={s.level} />
                      </td>
                      <td data-label={at("dashboard.col.free")}>
                        <span className={`${styles.badge} ${styles[`lvl_${s.level}`]}`}>
                          {s.level === "full" ? at("dashboard.full") : s.level === "closed" ? at("dashboard.closed") : s.free}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}
