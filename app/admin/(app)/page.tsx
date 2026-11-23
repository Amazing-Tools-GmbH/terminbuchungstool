import Link from "next/link";
import { canManage, requireAdmin } from "@/lib/auth/admin";
import { kpis, listEvents, listSlotBookings, listSlots, type AdminEvent, type AdminSlot, type AdminBooking } from "@/lib/admin/slots";
import { isAdminErrorCode } from "@/lib/admin/errors";
import { adminErrorText, at } from "@/lib/texts/admin";
import { formatDate } from "@/lib/datetime";
import styles from "@/components/admin/Admin.module.css";
import { createEventAction, createSlotAction, setCapacityAction } from "./actions";

type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function slotHref(eventId: string, slotId?: string) {
  const q = new URLSearchParams({ event: eventId });
  if (slotId) q.set("slot", slotId);
  return `/admin?${q.toString()}#event-${eventId}`;
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

/**
 * Events & Termine: jedes Event ist ein eigenes Panel mit seinen Terminen, Belegung,
 * Buchungen je Termin und „Termin hinzufügen“. Ein Buchungslink gilt für ein Event
 * und zeigt alle seine kommenden Termine.
 */
export default async function EventsPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireAdmin();
  const sp = await searchParams;
  const manage = canManage(ctx.role);
  const error = one(sp.error);
  const ok = one(sp.ok);
  const today = formatDate(new Date(), ctx.tenant.timezone).split(".").reverse().join("-");

  const events = await listEvents(ctx);
  const panels = await Promise.all(events.map(async (e) => ({ event: e, slots: await listSlots(ctx, e.id) })));
  const openSlotId = one(sp.slot);
  const open = panels.flatMap((p) => p.slots).find((s) => s.id === openSlotId) ?? null;
  const bookings = open ? await listSlotBookings(ctx, open.id) : [];
  const focus = one(sp.event);

  return (
    <>
      <div className={styles.headRow}>
        <div>
          <h1 className={styles.h1}>{at("slots.title")}</h1>
          <p className={styles.muted} style={{ margin: "4px 0 0" }}>
            {at("slots.intro")}
          </p>
        </div>
      </div>

      {error && (
        <p role="alert" className={styles.error}>
          {adminErrorText(isAdminErrorCode(error) ? error : "generic")}
        </p>
      )}
      {ok && (
        <p role="status" className={styles.notice}>
          {ok === "slot" ? at("form.saved") : ok === "event" ? at("event.form.saved") : at("capacity.saved")}
        </p>
      )}
      {one(sp.installed) && (
        <section className={styles.info} role="status">
          <strong>{at("installed.title")}</strong> {at("installed.text")}
        </section>
      )}

      {panels.length === 0 ? (
        manage ? (
          <EventForm open today={today} />
        ) : (
          <p className={styles.card}>{at("slots.noEvents")}</p>
        )
      ) : (
        <>
          {panels.map(({ event, slots }) => (
            <EventPanel
              key={event.id}
              event={event}
              slots={slots}
              manage={manage}
              today={today}
              open={open && slots.some((s) => s.id === open.id) ? open : null}
              bookings={bookings}
              addOpen={manage && focus === event.id && (ok === "slot" || error === "invalid_input" || error === "slot_in_past")}
            />
          ))}
          {!manage && <p className={styles.muted}>{at("form.readOnly")}</p>}
          {manage && <EventForm open={false} today={today} />}
        </>
      )}
    </>
  );
}

/** Ein Event als Panel: Kopf mit Kennzahlen, Termine, Buchungen des gewählten Termins, Termin hinzufügen */
function EventPanel(props: {
  event: AdminEvent;
  slots: AdminSlot[];
  manage: boolean;
  today: string;
  open: AdminSlot | null;
  bookings: AdminBooking[];
  addOpen: boolean;
}) {
  const { event, slots, manage, open } = props;
  const k = kpis(slots);
  return (
    <section className={styles.card} id={`event-${event.id}`} aria-labelledby={`event-title-${event.id}`}>
      <div className={styles.headRow}>
        <div>
          <h2 className={styles.h2} id={`event-title-${event.id}`} style={{ margin: 0 }}>
            {event.title}
          </h2>
          <p className={styles.muted} style={{ margin: "2px 0 0" }}>
            {[event.location, at("slots.summary", { slots: k.slots, booked: k.booked, capacity: k.capacity, pct: k.pct })].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>

      {slots.length === 0 ? (
        <p className={styles.muted}>{at("slots.empty")}</p>
      ) : (
        <div className={styles.tableCard} style={{ marginTop: 12 }}>
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
                        <details className={styles.inlineEdit}>
                          <summary className={styles.btnGhost}>{at("table.capacityEdit")}</summary>
                          <form action={setCapacityAction} className={styles.inlineForm}>
                            <input type="hidden" name="slotId" value={s.id} />
                            <input type="hidden" name="event" value={event.id} />
                            <label htmlFor={`cap-${s.id}`} className={styles.visuallyHidden}>
                              {at("table.capacityLabel", { date: s.date })}
                            </label>
                            <input
                              id={`cap-${s.id}`}
                              name="capacity"
                              type="number"
                              min={Math.max(1, s.booked)}
                              max={10000}
                              defaultValue={s.capacity}
                              required
                              aria-describedby={`cap-hint-${s.id}`}
                            />
                            <button type="submit" className={styles.btn}>
                              {at("table.capacitySave")}
                            </button>
                            <span id={`cap-hint-${s.id}`} className={styles.hint}>
                              {at("table.capacityHint", { booked: s.booked })}
                            </span>
                          </form>
                        </details>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <div className={styles.subCard} aria-live="polite">
          <div className={styles.headRow}>
            <h3 className={styles.h3}>{at("bookings.title", { date: `${open.weekdayShort}, ${open.date}` })}</h3>
            <Link href={slotHref(event.id)} className={styles.hint}>
              {at("bookings.close")}
            </Link>
          </div>
          {props.bookings.length === 0 ? (
            <p className={styles.muted}>{at("bookings.empty")}</p>
          ) : (
            <ul className={styles.list}>
              {props.bookings.map((b) => (
                <li key={b.id}>
                  <div>
                    <strong>{b.organization ?? b.name}</strong>
                    <div className={styles.hint}>
                      {b.organization ? `${b.name} · ` : ""}
                      {b.email}
                    </div>
                    {b.extraAttendees.length > 0 && <div className={styles.hint}>{at("bookings.extra", { names: b.extraAttendees.join(", ") })}</div>}
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
        </div>
      )}

      {manage && (
        <details className={styles.details} open={props.addOpen} style={{ marginTop: 12 }}>
          <summary>{at("slots.addSlot")}</summary>
          <form action={createSlotAction} className={styles.form}>
            <input type="hidden" name="eventId" value={event.id} />
            <div className={styles.field}>
              <label htmlFor={`d-${event.id}`}>{at("form.date")}</label>
              <input id={`d-${event.id}`} name="date" type="date" min={props.today} required />
            </div>
            <div className={styles.field}>
              <label htmlFor={`c-${event.id}`}>{at("form.capacity")}</label>
              <input id={`c-${event.id}`} name="capacity" type="number" min={1} max={10000} defaultValue={12} required />
            </div>
            <div className={styles.field}>
              <label htmlFor={`f-${event.id}`}>{at("form.from")}</label>
              <input id={`f-${event.id}`} name="from" type="time" defaultValue="10:00" required />
            </div>
            <div className={styles.field}>
              <label htmlFor={`t-${event.id}`}>{at("form.to")}</label>
              <input id={`t-${event.id}`} name="to" type="time" defaultValue="12:00" required />
            </div>
            <div className={`${styles.field} ${styles.full}`}>
              <label htmlFor={`l-${event.id}`}>{at("form.location")}</label>
              <input id={`l-${event.id}`} name="location" type="text" maxLength={200} placeholder={event.location ?? ""} aria-describedby={`lh-${event.id}`} />
              <span id={`lh-${event.id}`} className={styles.hint}>
                {at("form.locationHint")}
              </span>
            </div>
            <label className={`${styles.check} ${styles.full}`}>
              <input type="checkbox" name="open" defaultChecked /> {at("form.open")}
            </label>
            <div className={styles.full}>
              <button type="submit" className={styles.btn}>
                {at("form.submit")}
              </button>
            </div>
          </form>
        </details>
      )}
    </section>
  );
}

/**
 * Neues Event samt erstem Termin (owner/admin) – ein Formular, danach sofort buchbar.
 * Ohne Event offen als Hauptkarte, sonst eingeklappt unter den Events.
 */
function EventForm({ open, today }: { open: boolean; today: string }) {
  const fields = (
    <form action={createEventAction} className={styles.form}>
      <div className={`${styles.field} ${styles.full}`}>
        <label htmlFor="ev-title">{at("event.form.name")}</label>
        <input id="ev-title" name="title" type="text" required maxLength={200} />
      </div>
      <div className={`${styles.field} ${styles.full}`}>
        <label htmlFor="ev-location">{at("event.form.location")}</label>
        <input id="ev-location" name="location" type="text" maxLength={200} />
      </div>
      <div className={`${styles.field} ${styles.full}`}>
        <label htmlFor="ev-description">{at("event.form.description")}</label>
        <textarea id="ev-description" name="description" rows={3} maxLength={2000} className={styles.textarea} />
      </div>
      <fieldset className={`${styles.full} ${styles.fieldset}`} aria-describedby="ev-first-hint">
        <legend className={styles.h2}>{at("event.form.first")}</legend>
        <div className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="ev-date">{at("form.date")}</label>
            <input id="ev-date" name="date" type="date" min={today} required />
          </div>
          <div className={styles.field}>
            <label htmlFor="ev-capacity">{at("form.capacity")}</label>
            <input id="ev-capacity" name="capacity" type="number" min={1} max={10000} defaultValue={12} required />
          </div>
          <div className={styles.field}>
            <label htmlFor="ev-from">{at("form.from")}</label>
            <input id="ev-from" name="from" type="time" defaultValue="10:00" required />
          </div>
          <div className={styles.field}>
            <label htmlFor="ev-to">{at("form.to")}</label>
            <input id="ev-to" name="to" type="time" defaultValue="12:00" required />
          </div>
        </div>
        <p id="ev-first-hint" className={styles.hint}>
          {at("event.form.firstHint")}
        </p>
      </fieldset>
      <div className={styles.full}>
        <button type="submit" className={`${styles.btn} ${styles.btnLarge}`}>
          {at("event.form.submit")}
        </button>
      </div>
    </form>
  );
  if (open) {
    return (
      <section className={styles.card} aria-labelledby="new-event">
        <h2 className={styles.h2} id="new-event">
          {at("event.form.title")}
        </h2>
        {fields}
      </section>
    );
  }
  return (
    <details className={`${styles.card} ${styles.details}`}>
      <summary>{at("event.form.more")}</summary>
      {fields}
    </details>
  );
}
