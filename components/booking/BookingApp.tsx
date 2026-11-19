"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { formatText, type ResolvedTexts, type TextKey } from "@/lib/texts";
import { splitAttendees } from "@/lib/booking/input";
import styles from "./Booking.module.css";

export type SlotDisplay = {
  id: string;
  weekday: string;
  weekdayShort: string;
  date: string;
  time: string;
  location: string | null;
  capacity: number;
  booked: number;
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
  changeUntil: string;
  canChange: boolean;
  icsUrl: string;
  googleUrl: string;
  outlookUrl: string;
};

type Props = {
  token: string;
  texts: ResolvedTexts;
  event: { title: string; intro: string | null };
  invitation: { name: string; email: string };
  slots: SlotDisplay[];
  booking: BookingDisplay | null;
  bookingOpen: boolean;
  closedReason: string;
};

type Mode = "view" | "change";

export function BookingApp(props: Props) {
  const { texts, booking, slots, bookingOpen } = props;
  const t = (key: TextKey, vars?: Record<string, string | number>) => formatText(texts[key], vars);
  const router = useRouter();

  const [mode, setMode] = useState<Mode>("view");
  const [justBooked, setJustBooked] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  // Moduswechsel erst zusammen mit den neu geladenen Serverdaten anzeigen
  const [refreshing, startRefresh] = useTransition();

  const showConfirmation = booking !== null && mode === "view";

  if (showConfirmation) {
    return (
      <Confirmation
        t={t}
        booking={booking}
        announce={justBooked}
        onChange={() => {
          setJustBooked(false);
          setMode("change");
        }}
        onCancelled={() =>
          startRefresh(() => {
            setCancelled(true);
            setMode("view");
            router.refresh();
          })
        }
        refreshing={refreshing}
        token={props.token}
      />
    );
  }

  return (
    <>
      <section className={styles.hero}>
        <div className={`tb-container ${styles.heroInner}`}>
          <span className={styles.eyebrow}>{t("hero.eyebrow")}</span>
          <h1 className={styles.heroTitle}>{props.event.title}</h1>
          <p className={styles.heroIntro}>{props.event.intro || t("hero.intro")}</p>
        </div>
      </section>
      <div className={`tb-container ${styles.layout}`}>
        {cancelled && !booking && (
          <p className={styles.notice} role="status">
            {t("cancelled.notice")}
          </p>
        )}
        {!bookingOpen && (
          <p className={styles.notice} role="status">
            {props.closedReason}
          </p>
        )}
        <SelectionView
          {...props}
          t={t}
          changing={booking !== null && mode === "change"}
          onBack={() => setMode("view")}
          onBooked={() =>
            startRefresh(() => {
              setJustBooked(true);
              setCancelled(false);
              setMode("view");
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
  props: Props & { t: T; changing: boolean; onBack: () => void; onBooked: () => void; refreshing: boolean },
) {
  const { t, slots, booking, changing, bookingOpen } = props;
  const [selectedId, setSelectedId] = useState<string | null>(changing ? (booking?.slotId ?? null) : null);
  const [seats, setSeats] = useState(changing ? (booking?.seats ?? 1) : 1);
  const [name, setName] = useState(changing ? (booking?.name ?? props.invitation.name) : props.invitation.name);
  const [email, setEmail] = useState(changing ? (booking?.email ?? props.invitation.email) : props.invitation.email);
  const [extra, setExtra] = useState(changing ? (booking?.extraAttendees.join(", ") ?? "") : "");
  const [posting, setPosting] = useState(false);
  const submitting = posting || props.refreshing;
  const [error, setError] = useState<string | null>(null);
  const asideRef = useRef<HTMLElement>(null);
  const ids = { seats: useId(), name: useId(), email: useId(), extra: useId(), extraHint: useId(), error: useId() };

  const selected = slots.find((s) => s.id === selectedId) ?? null;
  // eigene bisherige Plätze sind beim Umbuchen wieder verfügbar
  const maxSeats = selected ? selected.free + selected.ownSeats : 0;

  useEffect(() => {
    if (selected && seats > maxSeats) setSeats(Math.max(1, maxSeats));
  }, [selected, seats, maxSeats]);

  function pick(slot: SlotDisplay) {
    setSelectedId(slot.id);
    setError(null);
    if (!changing) setSeats(1);
    // Auf schmalen Bildschirmen steht die Buchungsbox unter den Terminen
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 899px)").matches) {
      requestAnimationFrame(() => asideRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!selected || submitting) return;
    const extraAttendees = splitAttendees(extra);
    if (extraAttendees.length > seats - 1) {
      setError(t("error.invalid_attendees"));
      return;
    }
    setPosting(true);
    setError(null);
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: props.token, slotId: selected.id, seats, name, email, extraAttendees }),
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
          <ul className={styles.grid} role="list">
            {slots.map((s) => (
              <li key={s.id}>
                <SlotCard slot={s} t={t} selected={s.id === selectedId} disabled={!bookingOpen || !s.bookable} onPick={() => pick(s)} />
              </li>
            ))}
          </ul>
        )}
      </main>

      <aside ref={asideRef} className={styles.aside} aria-labelledby={`${ids.seats}-title`}>
        <div className={styles.asideStrip} aria-hidden="true" />
        <h2 id={`${ids.seats}-title`} className={styles.asideTitle}>
          {changing ? t("aside.changeTitle") : t("aside.title")}
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

            <div className={styles.field}>
              <label htmlFor={ids.extra} className={styles.label}>
                {t("aside.extra")}
              </label>
              <input
                id={ids.extra}
                className={styles.input}
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
                placeholder={t("aside.extraPlaceholder")}
                aria-describedby={ids.extraHint}
                disabled={seats <= 1}
              />
              <span id={ids.extraHint} className={styles.hint}>
                {t("aside.extraHint")}
              </span>
            </div>

            {error && (
              <p id={ids.error} className={styles.error} role="alert">
                {error}
              </p>
            )}

            <button type="submit" className={styles.submit} disabled={submitting || !bookingOpen}>
              {submitting ? t("aside.submitting") : changing ? t("aside.changeSubmit") : t("aside.submit")}
              {!submitting && (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                  <path d="m9 6 6 6-6 6" />
                </svg>
              )}
            </button>
            <p className={styles.hint}>{t("aside.help")}</p>
          </form>
        )}

        {changing && (
          <button type="button" className={styles.linkButton} onClick={props.onBack}>
            {t("aside.changeBack")}
          </button>
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
  const pct = slot.capacity > 0 ? Math.min(100, Math.round((slot.booked / slot.capacity) * 100)) : 100;
  const level = full ? "full" : slot.free <= 3 ? "low" : "ok";
  const freeText = full
    ? t("slots.full")
    : slot.free === 1
      ? t("slots.freeOne", { capacity: slot.capacity })
      : t("slots.free", { free: slot.free, capacity: slot.capacity });

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
        <span className={styles.bar} aria-hidden="true">
          <span className={styles.barFill} style={{ width: `${pct}%` }} />
        </span>
        <span className={styles.cardFree}>{freeText}</span>
      </span>
    </button>
  );
}

function Confirmation({
  t,
  booking,
  announce,
  onChange,
  onCancelled,
  token,
  refreshing,
}: {
  t: T;
  booking: BookingDisplay;
  announce: boolean;
  onChange: () => void;
  onCancelled: () => void;
  token: string;
  refreshing: boolean;
}) {
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (announce) headingRef.current?.focus();
  }, [announce]);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/bookings/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!res.ok || !data.ok) {
        setError(data.message ?? t("error.generic"));
        return;
      }
      onCancelled();
    } catch {
      setError(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

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
            <dd>{booking.extraAttendees.join(", ")}</dd>
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

      {booking.canChange ? (
        <div className={styles.changeArea}>
          <p className={styles.muted}>{t("done.changeUntil", { until: booking.changeUntil })}</p>
          <div className={styles.changeActions}>
            <button type="button" className={styles.linkButton} onClick={onChange}>
              {t("done.change")}
            </button>
            {!confirmCancel ? (
              <button type="button" className={styles.linkButtonMuted} onClick={() => setConfirmCancel(true)}>
                {t("done.cancel")}
              </button>
            ) : (
              <span className={styles.confirmBox} role="group" aria-label={t("done.cancel")}>
                <span>{t("done.cancelConfirm")}</span>
                <button type="button" className={styles.dangerButton} onClick={cancel} disabled={busy || refreshing}>
                  {t("done.cancelYes")}
                </button>
                <button type="button" className={styles.linkButtonMuted} onClick={() => setConfirmCancel(false)} disabled={busy}>
                  {t("done.cancelNo")}
                </button>
              </span>
            )}
          </div>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </div>
      ) : (
        <p className={styles.muted}>{t("done.deadlinePassed")}</p>
      )}
    </main>
  );
}
