import Link from "next/link";
import { canManage, requireAdmin } from "@/lib/auth/admin";
import { flashMessages } from "@/lib/admin/messages";
import { cancelBookingAction } from "../actions";
import { BOOKING_VIEWS, listBookings, type BookingView } from "@/lib/admin/bookings";
import { listEvents } from "@/lib/admin/slots";
import { formatDateTime } from "@/lib/datetime";
import { at } from "@/lib/texts/admin";
import styles from "@/components/admin/Admin.module.css";

type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function BookingsPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireAdmin();
  const sp = await searchParams;
  const view: BookingView = (BOOKING_VIEWS as readonly string[]).includes(one(sp.view) ?? "") ? (one(sp.view) as BookingView) : "upcoming";
  const eventParam = one(sp.event);
  const eventId = eventParam && UUID.test(eventParam) ? eventParam : null;
  const [events, { items, truncated }] = await Promise.all([listEvents(ctx), listBookings(ctx, { view, eventId })]);
  const tz = ctx.tenant.timezone;
  const href = (v: BookingView) => `/admin/buchungen?${new URLSearchParams({ view: v, ...(eventId ? { event: eventId } : {}) })}`;
  const seats = items.reduce((n, b) => n + b.seats, 0);
  const manage = canManage(ctx.role) && view === "upcoming";
  const { ok, error } = flashMessages(sp);

  return (
    <>
      <div className={styles.headRow}>
        <div>
          <h1 className={styles.h1}>{at("bookingList.title")}</h1>
          <p className={styles.muted} style={{ margin: 0 }}>
            {at("bookingList.intro")}
          </p>
        </div>
      </div>

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

      <div className={styles.filterBar}>
        <nav aria-label={at("bookingList.views")} className={styles.tabs}>
          {BOOKING_VIEWS.map((v) => (
            <Link key={v} href={href(v)} className={styles.tab} aria-current={v === view ? "page" : undefined}>
              {at(`bookingList.view.${v}`)}
            </Link>
          ))}
        </nav>
        <form method="get" className={styles.inlineForm}>
          <input type="hidden" name="view" value={view} />
          <label htmlFor="booking-event" className={styles.visuallyHidden}>
            {at("bookingList.event")}
          </label>
          <select id="booking-event" name="event" defaultValue={eventId ?? ""} className={styles.inlineSelect}>
            <option value="">{at("bookingList.allEvents")}</option>
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </select>
          <button type="submit" className={styles.btnGhost}>
            {at("bookingList.filter")}
          </button>
        </form>
      </div>

      {truncated && (
        <p role="status" className={styles.info}>
          {at("bookingList.truncated")}
        </p>
      )}

      {items.length === 0 ? (
        <p className={`${styles.card} ${styles.muted}`}>{at("bookingList.empty")}</p>
      ) : (
        <>
          <p className={styles.hint} style={{ margin: 0 }}>
            {at("bookingList.count", { n: items.length, seats })}
          </p>
          <div className={styles.tableCard}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{at("bookingList.col.date")}</th>
                  <th scope="col">{at("bookingList.col.event")}</th>
                  <th scope="col">{at("bookingList.col.customer")}</th>
                  <th scope="col">{at("bookingList.col.seats")}</th>
                  <th scope="col">{at("bookingList.col.bookedBy")}</th>
                  <th scope="col">{view === "cancelled" ? at("bookingList.col.cancelledAt") : at("bookingList.col.bookedAt")}</th>
                  {manage && <th scope="col">{at("table.actions")}</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((b) => (
                  <tr key={b.id}>
                    <td data-label={at("bookingList.col.date")} className={styles.nowrap}>
                      <strong>
                        {b.weekdayShort}, {b.date}
                      </strong>
                      <div className={styles.hint}>{b.time}</div>
                    </td>
                    <td data-label={at("bookingList.col.event")}>
                      {b.eventTitle}
                      {b.location && <div className={styles.hint}>{b.location}</div>}
                    </td>
                    <td data-label={at("bookingList.col.customer")}>
                      <strong>{b.organization ?? b.customer}</strong>
                      <div className={styles.hint}>
                        {b.organization ? `${b.customer} · ` : ""}
                        {b.email}
                      </div>
                      <div className={styles.hint}>
                        {b.dealUrl && (
                          <>
                            <a href={b.dealUrl} target="_blank" rel="noopener noreferrer">
                              {at("bookings.deal")}
                            </a>
                            {canManage(ctx.role) ? " · " : ""}
                          </>
                        )}
                        {canManage(ctx.role) && <Link href={`/admin/verlauf?inv=${b.invitationId}`}>{at("nav.activity")}</Link>}
                      </div>
                    </td>
                    <td data-label={at("bookingList.col.seats")}>
                      <strong>{b.seats}</strong>
                      {b.extraAttendees.length > 0 && <div className={styles.hint}>{at("bookings.extra", { names: b.extraAttendees.join(", ") })}</div>}
                    </td>
                    <td data-label={at("bookingList.col.bookedBy")}>
                      {b.bookedBy ? at("bookingList.staff", { name: b.bookedBy }) : at("bookingList.self", { name: b.customer })}
                    </td>
                    <td data-label={view === "cancelled" ? at("bookingList.col.cancelledAt") : at("bookingList.col.bookedAt")} className={styles.nowrap}>
                      {formatDateTime(view === "cancelled" && b.cancelledAt ? b.cancelledAt : b.createdAt, tz)}
                    </td>
                    {manage && (
                      <td data-label={at("table.actions")}>
                        <details className={styles.inlineEdit}>
                          <summary className={styles.btnGhost}>{at("manage.booking.cancel")}</summary>
                          <form action={cancelBookingAction} className={`${styles.brandingFields} ${styles.popover}`}>
                            <input type="hidden" name="bookingId" value={b.id} />
                            <input type="hidden" name="back" value="list" />
                            <label className={styles.check}>
                              <input type="checkbox" name="notify" defaultChecked /> {at("manage.notify")}
                            </label>
                            <div>
                              <button type="submit" className={styles.btnDanger}>
                                {at("manage.booking.cancelSubmit")}
                              </button>
                            </div>
                          </form>
                        </details>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
