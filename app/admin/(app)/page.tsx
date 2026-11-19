import Link from "next/link";
import { canManage, requireAdmin } from "@/lib/auth/admin";
import { kpis, listEvents, listSlotBookings, listSlots, type AdminSlot } from "@/lib/admin/slots";
import { isAdminErrorCode } from "@/lib/admin/errors";
import { adminErrorText, at } from "@/lib/texts/admin";
import { formatDate } from "@/lib/datetime";
import styles from "@/components/admin/Admin.module.css";
import { createSlotAction, increaseCapacityAction } from "./actions";
import { withBasePath } from "@/lib/base-path";

type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function slotHref(eventId: string, slotId?: string) {
  const q = new URLSearchParams({ event: eventId });
  if (slotId) q.set("slot", slotId);
  return `/admin?${q.toString()}#buchungen`;
}

function Occupancy({ s }: { s: AdminSlot }) {
  return (
    <>
      <span>
        {s.booked} / {s.capacity}
      </span>
      <div className={styles.bar} aria-hidden="true">
        <span className={styles[`fill_${s.level}`]} style={{ width: `${s.pct}%` }} />
      </div>
    </>
  );
}

export default async function SlotsPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireAdmin();
  const sp = await searchParams;
  const events = await listEvents(ctx);
  const manage = canManage(ctx.role);
  const error = one(sp.error);
  const ok = one(sp.ok);

  const event = events.find((e) => e.id === one(sp.event)) ?? events[0];
  const slots = event ? await listSlots(ctx, event.id) : [];
  const open = slots.find((s) => s.id === one(sp.slot)) ?? null;
  const bookings = open ? await listSlotBookings(ctx, open.id) : [];
  const k = kpis(slots);
  const today = formatDate(new Date(), ctx.tenant.timezone).split(".").reverse().join("-");

  return (
    <>
      <div className={styles.headRow}>
        <div>
          <h1 className={styles.h1}>{at("slots.title")}</h1>
          {event && (
            <p className={styles.muted} style={{ margin: "4px 0 0" }}>
              {at("slots.event")}: {event.title}
            </p>
          )}
        </div>
        {events.length > 1 && (
          <form method="get" action={withBasePath("/admin")} className={styles.actions}>
            <label className={styles.visuallyHidden} htmlFor="event-switch">
              {at("slots.event")}
            </label>
            <select id="event-switch" name="event" defaultValue={event?.id} className={styles.inlineSelect}>
              {events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title}
                </option>
              ))}
            </select>
            <button type="submit" className={styles.btnGhost}>
              {at("slots.eventSwitch")}
            </button>
          </form>
        )}
      </div>

      {error && (
        <p role="alert" className={styles.error}>
          {adminErrorText(isAdminErrorCode(error) ? error : "generic")}
        </p>
      )}
      {ok && (
        <p role="status" className={styles.notice}>
          {ok === "slot" ? at("form.saved") : at("capacity.saved")}
        </p>
      )}

      {!event ? (
        <p className={styles.card}>{at("slots.noEvents")}</p>
      ) : (
        <>
          <dl className={styles.kpis}>
            <div className={styles.kpi}>
              <dt>{at("kpi.slots")}</dt>
              <dd>{k.slots}</dd>
            </div>
            <div className={styles.kpi}>
              <dt>{at("kpi.capacity")}</dt>
              <dd>{k.capacity}</dd>
            </div>
            <div className={styles.kpi}>
              <dt>{at("kpi.booked")}</dt>
              <dd>{k.booked}</dd>
            </div>
            <div className={styles.kpi}>
              <dt>{at("kpi.pct")}</dt>
              <dd>{k.pct} %</dd>
            </div>
          </dl>

          <div className={styles.split}>
            <div className={styles.tableCard}>
              {slots.length === 0 ? (
                <p style={{ padding: 20, margin: 0 }}>{at("slots.empty")}</p>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">{at("table.date")}</th>
                      <th scope="col">{at("table.time")}</th>
                      <th scope="col">{at("table.location")}</th>
                      <th scope="col">{at("table.occupancy")}</th>
                      <th scope="col">{at("table.status")}</th>
                      <th scope="col">{at("table.actions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slots.map((s) => (
                      <tr key={s.id} data-open={open?.id === s.id}>
                        <td className={styles.nowrap} data-label={at("table.date")}>
                          {s.weekdayShort}, {s.date}
                        </td>
                        <td className={styles.nowrap} data-label={at("table.time")}>
                          {s.time}
                        </td>
                        <td data-label={at("table.location")}>{s.location ?? "—"}</td>
                        <td data-label={at("table.occupancy")}>
                          <Occupancy s={s} />
                        </td>
                        <td data-label={at("table.status")}>
                          <span className={`${styles.badge} ${styles[`lvl_${s.level}`]}`}>{at(`status.${s.level}`)}</span>
                        </td>
                        <td data-label={at("table.actions")}>
                          <div className={styles.rowActions}>
                            <Link className={styles.btnGhost} href={slotHref(event.id, s.id)} aria-current={open?.id === s.id ? "true" : undefined}>
                              {at("table.bookings")}
                            </Link>
                            {manage && s.level !== "cancelled" && (
                              <form action={increaseCapacityAction}>
                                <input type="hidden" name="slotId" value={s.id} />
                                <input type="hidden" name="event" value={event.id} />
                                <button type="submit" className={styles.btnGhost} aria-label={at("table.capacityUpLabel", { date: s.date })}>
                                  {at("table.capacityUp")}
                                </button>
                              </form>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <section className={styles.card} id="buchungen" aria-live="polite">
              {open ? (
                <>
                  <div className={styles.headRow}>
                    <h2 className={styles.h2}>{at("bookings.title", { date: `${open.weekdayShort}, ${open.date}` })}</h2>
                    <Link href={slotHref(event.id)} className={styles.hint}>
                      {at("bookings.close")}
                    </Link>
                  </div>
                  {bookings.length === 0 ? (
                    <p className={styles.muted}>{at("bookings.empty")}</p>
                  ) : (
                    <ul className={styles.list}>
                      {bookings.map((b) => (
                        <li key={b.id}>
                          <div>
                            <strong>{b.organization ?? b.name}</strong>
                            <div className={styles.hint}>
                              {b.organization ? `${b.name} · ` : ""}
                              {b.email}
                            </div>
                            {b.extraAttendees.length > 0 && (
                              <div className={styles.hint}>{at("bookings.extra", { names: b.extraAttendees.join(", ") })}</div>
                            )}
                            <div className={styles.hint}>
                              {b.dealUrl ? (
                                <a href={b.dealUrl} target="_blank" rel="noopener noreferrer">
                                  {at("bookings.deal")}
                                </a>
                              ) : (
                                at("bookings.noDeal")
                              )}
                            </div>
                          </div>
                          <span className={styles.nowrap}>{at("bookings.seats", { n: b.seats })}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <p className={styles.muted} style={{ margin: 0 }}>
                  {at("bookings.pick")}
                </p>
              )}
            </section>
          </div>

          <section className={styles.card} aria-labelledby="new-slot">
            <h2 className={styles.h2} id="new-slot">
              {at("form.title")}
            </h2>
            {manage ? (
              <form action={createSlotAction} className={styles.form}>
                <div className={`${styles.field} ${styles.full}`}>
                  <label htmlFor="f-event">{at("form.event")}</label>
                  <select id="f-event" name="eventId" defaultValue={event.id} required>
                    {events.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div className={styles.field}>
                  <label htmlFor="f-date">{at("form.date")}</label>
                  <input id="f-date" name="date" type="date" min={today} required />
                </div>
                <div className={styles.field}>
                  <label htmlFor="f-capacity">{at("form.capacity")}</label>
                  <input id="f-capacity" name="capacity" type="number" min={1} max={10000} defaultValue={12} required />
                </div>
                <div className={styles.field}>
                  <label htmlFor="f-from">{at("form.from")}</label>
                  <input id="f-from" name="from" type="time" defaultValue="10:00" required />
                </div>
                <div className={styles.field}>
                  <label htmlFor="f-to">{at("form.to")}</label>
                  <input id="f-to" name="to" type="time" defaultValue="12:00" required />
                </div>
                <div className={`${styles.field} ${styles.full}`}>
                  <label htmlFor="f-location">{at("form.location")}</label>
                  <input id="f-location" name="location" type="text" maxLength={200} placeholder={event.location ?? ""} aria-describedby="f-location-hint" />
                  <span id="f-location-hint" className={styles.hint}>
                    {at("form.locationHint")}
                  </span>
                </div>
                <label className={`${styles.check} ${styles.full}`}>
                  <input type="checkbox" name="open" defaultChecked /> {at("form.open")}
                </label>
                <div className={styles.full}>
                  <button type="submit" className={`${styles.btn} ${styles.btnLarge}`}>
                    {at("form.submit")}
                  </button>
                </div>
              </form>
            ) : (
              <p className={styles.muted}>{at("form.readOnly")}</p>
            )}
          </section>
        </>
      )}
    </>
  );
}
