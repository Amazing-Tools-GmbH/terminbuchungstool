"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { formatText, type ResolvedTexts, type TextKey } from "@/lib/texts";
import { checkAttendees } from "@/lib/booking/input";
import styles from "./Booking.module.css";

export type SlotDisplay = {
  id: string;
  weekday: string;
  weekdayShort: string;
  date: string;
  time: string;
  /** Tag (YYYY-MM-DD, Mandanten-Zeitzone) für die Tagesauswahl */
  dayKey: string;
  dayNum: string;
  monthShort: string;
  location: string | null;
  /** null = Event zeigt keine Platzzahlen */
  capacity: number | null;
  booked: number | null;
  free: number;
  /** eigene Plätze in diesem Slot (bei bestehender Buchung) */
  ownSeats: number;
  bookable: boolean;
};

export type BookingDisplay = {
  slotId: string;
  weekday: string;
  weekdayShort: string;
  date: string;
  time: string;
  location: string | null;
  seats: number;
  name: string;
  email: string;
  extraAttendees: string[];
  /** weitere Teilnehmer mit eigener Einladung */
  guests: { name: string; email: string }[];
  icsUrl: string;
  googleUrl: string;
  outlookUrl: string;
};

type Props = {
  token: string;
  texts: ResolvedTexts;
  event: { title: string; intro: string | null; showSeats: boolean };
  invitation: { name: string; email: string };
  slots: SlotDisplay[];
  booking: BookingDisplay | null;
  bookingOpen: boolean;
  closedReason: string;
  /** Ansprechpartner (einladender Mitarbeiter) – Hinweis statt Umbuchen/Stornieren */
  contactName: string | null;
};

export function BookingApp(props: Props) {
  const { texts, booking, slots, bookingOpen } = props;
  const t = (key: TextKey, vars?: Record<string, string | number>) => formatText(texts[key], vars);
  const router = useRouter();

  const [justBooked, setJustBooked] = useState(false);
  // Bestätigung erst zusammen mit den neu geladenen Serverdaten anzeigen
  const [refreshing, startRefresh] = useTransition();

  // Gebucht: nur noch die Bestätigung (kein Umbuchen/Stornieren durch Kunden)
  if (booking) return <Confirmation t={t} booking={booking} announce={justBooked} contactName={props.contactName} />;

  return (
    <>
      <section className={styles.hero}>
        <div className={`tb-container ${styles.heroInner}`}>
          <span className={styles.eyebrow}>{t("hero.eyebrow")}</span>
          <h1 className={styles.heroTitle}>{props.event.title}</h1>
          <p className={styles.heroIntro}>{props.event.intro || t(props.event.showSeats ? "hero.intro" : "hero.introNoSeats")}</p>
        </div>
      </section>
      <div className={`tb-container ${styles.layout}`}>
        {!bookingOpen && (
          <p className={styles.notice} role="status">
            {props.closedReason}
          </p>
        )}
        <SelectionView
          {...props}
          t={t}
          onBooked={() =>
            startRefresh(() => {
              setJustBooked(true);
              router.refresh();
            })
          }
          refreshing={refreshing}
          slots={slots}
        />
      </div>
    </>
  );
}

type T = (key: TextKey, vars?: Record<string, string | number>) => string;

function SelectionView(
  props: Props & { t: T; onBooked: () => void; refreshing: boolean },
) {
  const { t, slots, bookingOpen } = props;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const days = [...new Set(slots.map((x) => x.dayKey))];
  const [day, setDay] = useState<string | null>(() => slots.find((x) => x.bookable)?.dayKey ?? days[0] ?? null);
  const daySlots = slots.filter((x) => x.dayKey === day);
  const [seats, setSeats] = useState(1);
  const [name, setName] = useState(props.invitation.name);
  const [email, setEmail] = useState(props.invitation.email);
  const [attendees, setAttendees] = useState<{ name: string; email: string }[]>([]);
  const [inviteGuests, setInviteGuests] = useState(false);
  const [posting, setPosting] = useState(false);
  const submitting = posting || props.refreshing;
  const [error, setError] = useState<string | null>(null);
  const asideRef = useRef<HTMLElement>(null);
  const ids = { seats: useId(), name: useId(), email: useId(), extra: useId(), invite: useId(), inviteHint: useId(), error: useId() };

  const selected = slots.find((s) => s.id === selectedId) ?? null;
  const maxSeats = selected ? selected.free + selected.ownSeats : 0;

  useEffect(() => {
    if (selected && seats > maxSeats) setSeats(Math.max(1, maxSeats));
  }, [selected, seats, maxSeats]);

  function pick(slot: SlotDisplay) {
    setSelectedId(slot.id);
    setError(null);
    setSeats(1);
    // Auf schmalen Bildschirmen steht die Buchungsbox unter den Terminen
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 899px)").matches) {
      requestAnimationFrame(() => asideRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!selected || submitting) return;
    const checked = checkAttendees(attendees.slice(0, seats - 1), seats, inviteGuests && seats > 1, email);
    if (!checked.ok) {
      setError(t(`error.${checked.error}`));
      return;
    }
    const { extraAttendees, guests } = checked;
    setPosting(true);
    setError(null);
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: props.token, slotId: selected.id, seats, name, email, extraAttendees, guests }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!res.ok || !data.ok) {
        setError(data.message ?? t("error.generic"));
        return;
      }
      props.onBooked();
    } catch {
      setError(t("error.generic"));
    } finally {
      setPosting(false);
    }
  }

  return (
    <>
      <main className={styles.main}>
        <h2 className={styles.sectionTitle}>{t("slots.title")}</h2>
        {slots.length === 0 ? (
          <p className={styles.muted}>{t("slots.empty")}</p>
        ) : (
          <>
            <div role="group" aria-label={t("slots.days")} className={styles.days}>
              {days.map((k) => {
                const list = slots.filter((x) => x.dayKey === k);
                const first = list[0]!;
                const full = !list.some((x) => x.bookable);
                return (
                  <button
                    key={k}
                    type="button"
                    className={styles.day}
                    aria-pressed={day === k}
                    data-full={full || undefined}
                    data-picked={list.some((x) => x.id === selectedId) || undefined}
                    aria-label={`${first.weekday}, ${first.date}${full ? `, ${t("slots.full")}` : ""}`}
                    onClick={() => setDay(k)}
                  >
                    <span className={styles.dayWd}>{first.weekdayShort}</span>
                    <span className={styles.dayNum}>{first.dayNum}</span>
                    <span className={styles.daySub}>{full ? t("slots.full") : first.monthShort}</span>
                  </button>
                );
              })}
            </div>
            {day && (
              <>
                <h3 className={styles.dayTitle}>{t("slots.onDay", { day: `${daySlots[0]?.weekday ?? ""}, ${daySlots[0]?.date ?? ""}` })}</h3>
                <ul className={styles.grid} role="list">
                  {daySlots.map((s) => (
                    <li key={s.id}>
                      <SlotCard slot={s} t={t} selected={s.id === selectedId} disabled={!bookingOpen || !s.bookable} onPick={() => pick(s)} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </main>

      <aside ref={asideRef} className={styles.aside} aria-labelledby={`${ids.seats}-title`}>
        <div className={styles.asideStrip} aria-hidden="true" />
        <h2 id={`${ids.seats}-title`} className={styles.asideTitle}>
          {t("aside.title")}
        </h2>

        {!selected ? (
          <p className={styles.muted}>
            {/* Desktop: Termine stehen links, schmal: darüber */}
            <span className={styles.wideOnly}>{t("aside.noSelection")}</span>
            <span className={styles.narrowOnly}>{t("aside.noSelectionStacked")}</span>
          </p>
        ) : (
          <form className={styles.form} onSubmit={submit} noValidate aria-describedby={error ? ids.error : undefined}>
            <div className={styles.selection} aria-live="polite">
              <div className={styles.selectionDate}>
                {selected.weekday}, {selected.date}
              </div>
              <div className={styles.selectionMeta}>
                {selected.time}
                {selected.location ? ` · ${selected.location}` : ""}
              </div>
            </div>

            <div className={styles.field}>
              <span id={ids.seats} className={styles.label}>
                {t("aside.seats")}
              </span>
              <div role="group" aria-labelledby={ids.seats} className={styles.stepper}>
                <button
                  type="button"
                  className={styles.stepButton}
                  aria-label={t("aside.seatsLess")}
                  onClick={() => setSeats((n) => Math.max(1, n - 1))}
                  disabled={seats <= 1}
                >
                  −
                </button>
                <output className={styles.stepValue} aria-live="polite">
                  {seats}
                </output>
                <button
                  type="button"
                  className={styles.stepButton}
                  aria-label={t("aside.seatsMore")}
                  onClick={() => setSeats((n) => Math.min(maxSeats, n + 1))}
                  disabled={seats >= maxSeats}
                >
                  +
                </button>
                <span className={styles.muted}>{t("aside.seatsMax", { max: maxSeats })}</span>
              </div>
            </div>

            <div className={styles.field}>
              <label htmlFor={ids.name} className={styles.label}>
                {t("aside.name")}
              </label>
              <input
                id={ids.name}
                className={styles.input}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                required
                maxLength={200}
              />
            </div>

            <div className={styles.field}>
              <label htmlFor={ids.email} className={styles.label}>
                {t("aside.email")}
              </label>
              <input
                id={ids.email}
                className={styles.input}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
                maxLength={254}
              />
            </div>

            {seats > 1 && (
              <fieldset className={styles.guests}>
                <legend className={styles.label}>{t("aside.extra")}</legend>
                <label className={styles.checkRow}>
                  <input
                    id={ids.invite}
                    type="checkbox"
                    checked={inviteGuests}
                    onChange={(e) => setInviteGuests(e.target.checked)}
                    aria-describedby={ids.inviteHint}
                  />
                  <span>{t("aside.guestsInvite")}</span>
                </label>
                <span id={ids.inviteHint} className={styles.hint}>
                  {t("aside.guestsInviteHint")}
                </span>
                {Array.from({ length: seats - 1 }, (_, i) => {
                  const row = attendees[i] ?? { name: "", email: "" };
                  const update = (patch: Partial<typeof row>) =>
                    setAttendees((list) => {
                      const next = Array.from({ length: Math.max(list.length, i + 1) }, (_, k) => list[k] ?? { name: "", email: "" });
                      next[i] = { ...row, ...patch };
                      return next;
                    });
                  return (
                    <div key={i} className={styles.guestRow}>
                      <label className={styles.field}>
                        <span className={styles.label}>{t("aside.guestName", { n: i + 2 })}</span>
                        <input className={styles.input} value={row.name} maxLength={200} onChange={(e) => update({ name: e.target.value })} />
                      </label>
                      {inviteGuests && (
                        <label className={styles.field}>
                          <span className={styles.label}>{t("aside.guestEmail", { n: i + 2 })}</span>
                          <input
                            className={styles.input}
                            type="email"
                            autoComplete="off"
                            value={row.email}
                            maxLength={254}
                            onChange={(e) => update({ email: e.target.value })}
                          />
                        </label>
                      )}
                    </div>
                  );
                })}
              </fieldset>
            )}

            {error && (
              <p id={ids.error} className={styles.error} role="alert">
                {error}
              </p>
            )}

            <button type="submit" className={styles.submit} disabled={submitting || !bookingOpen}>
              {submitting ? t("aside.submitting") : t("aside.submit")}
              {!submitting && (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                  <path d="m9 6 6 6-6 6" />
                </svg>
              )}
            </button>
            <p className={styles.hint}>{t("aside.help")}</p>
          </form>
        )}

      </aside>
    </>
  );
}

function SlotCard({
  slot,
  t,
  selected,
  disabled,
  onPick,
}: {
  slot: SlotDisplay;
  t: T;
  selected: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const full = slot.free + slot.ownSeats <= 0;
  const showSeats = slot.capacity !== null && slot.booked !== null;
  const pct = showSeats && slot.capacity! > 0 ? Math.min(100, Math.round((slot.booked! / slot.capacity!) * 100)) : full ? 100 : 0;
  const level = full ? "full" : showSeats && slot.free <= 3 ? "low" : "ok";
  const freeText = full
    ? t("slots.full")
    : !showSeats
      ? t("slots.available")
      : slot.free === 1
        ? t("slots.freeOne", { capacity: slot.capacity! })
        : t("slots.free", { free: slot.free, capacity: slot.capacity! });

  return (
    <button
      type="button"
      className={styles.card}
      data-selected={selected || undefined}
      data-level={level}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onPick}
    >
      <span className={styles.cardDay}>{slot.weekday}</span>
      <span className={styles.cardDate}>{slot.date}</span>
      <span className={styles.cardMeta}>
        {slot.time}
        {slot.location ? ` · ${slot.location}` : ""}
      </span>
      <span className={styles.cardLoad}>
        {showSeats && (
          <span className={styles.bar} aria-hidden="true">
            <span className={styles.barFill} style={{ width: `${pct}%` }} />
          </span>
        )}
        <span className={styles.cardFree}>{freeText}</span>
      </span>
    </button>
  );
}

function Confirmation({ t, booking, announce, contactName }: { t: T; booking: BookingDisplay; announce: boolean; contactName: string | null }) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (announce) headingRef.current?.focus();
  }, [announce]);

  return (
    <main className={`tb-container ${styles.done}`}>
      <div className={styles.doneIcon} aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="m5 12 5 5 9-10" />
        </svg>
      </div>
      <div role="status">
        <h1 ref={headingRef} tabIndex={-1} className={styles.doneTitle}>
          {t("done.title")}
        </h1>
        <p className={styles.doneText}>
          {t("done.text")} <strong>{booking.email}</strong>.
        </p>
      </div>

      <dl className={styles.summary}>
        <div>
          <dt>{t("done.date")}</dt>
          <dd>
            {booking.weekday}, {booking.date}
          </dd>
        </div>
        <div>
          <dt>{t("done.time")}</dt>
          <dd>{booking.time}</dd>
        </div>
        {booking.location && (
          <div>
            <dt>{t("done.place")}</dt>
            <dd>{booking.location}</dd>
          </div>
        )}
        <div>
          <dt>{t("done.seats")}</dt>
          <dd>{booking.seats}</dd>
        </div>
        {booking.extraAttendees.length > 0 && (
          <div className={styles.summaryWide}>
            <dt>{t("done.attendees")}</dt>
            <dd>
              {initialAttendees(booking).map((a, i) => (
                <span key={i} className={styles.attendee}>
                  {a.name}
                  {a.email && <span className={styles.attendeeNote}>{` · ${t("done.guestInvited", { email: a.email })}`}</span>}
                </span>
              ))}
            </dd>
          </div>
        )}
      </dl>

      <div className={styles.calendarRow}>
        <a className={styles.primaryLink} href={booking.icsUrl} download>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
          </svg>
          {t("done.ics")}
        </a>
        <a className={styles.secondaryLink} href={booking.googleUrl} target="_blank" rel="noopener noreferrer">
          {t("done.google")}
        </a>
        <a className={styles.secondaryLink} href={booking.outlookUrl} target="_blank" rel="noopener noreferrer">
          {t("done.outlook")}
        </a>
      </div>

      <p className={styles.contactNote}>{contactName ? t("done.contact", { name: contactName }) : t("done.contactFallback")}</p>
    </main>
  );
}

/** Namen der weiteren Teilnehmer mit ggf. E-Mail der eigenen Einladung (Zuordnung über den Namen) */
function initialAttendees(b: BookingDisplay): { name: string; email: string }[] {
  const open = [...b.guests];
  return b.extraAttendees.map((name) => {
    const i = open.findIndex((g) => g.name === name);
    const email = i >= 0 ? open.splice(i, 1)[0]!.email : "";
    return { name, email };
  });
}
