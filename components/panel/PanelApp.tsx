"use client";
/**
 * Vertriebs-Panel im Pipedrive-Deal (Mock-up 1-pipedrive-panel): Kontakt mit
 * Status, Event, nur die Tage mit Terminen des Events (Tag + Uhrzeit wählen), Buchungslink
 * senden (Standard: gewählter Termin; über ▾ mehrere oder alle Termine des Events),
 * persönlicher Link, freie Plätze. Läuft im iframe von Pipedrive; das SDK
 * wird nur dort initialisiert (Größe anpassen, Hinweise, Sitzung erneuern).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelContext, PanelEvent, PanelSlot } from "@/lib/panel/context";
import { formatText } from "@/lib/texts";
import styles from "./Panel.module.css";
import { usePipedriveSdk } from "./usePipedriveSdk";

type Texts = Record<string, string>;
type Identity = { userId: number; companyId: number; dealId: number };

const toDate = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
};
/** „GMT+01:00 Mitteleuropäische Normalzeit“ für die Zeitzone des Mandanten */
function tzLabel(tz: string): string {
  const part = (style: "longOffset" | "long") =>
    new Intl.DateTimeFormat("de-AT", { timeZone: tz, timeZoneName: style }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "";
  try {
    return [part("longOffset"), part("long")].filter(Boolean).join(" ") || tz;
  } catch {
    return tz;
  }
}
const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("de-AT", { timeZone: "UTC", ...opts });

function firstOpen(ev: PanelEvent | undefined): PanelSlot | undefined {
  return ev?.slots.find((s) => s.free > 0);
}

export function PanelApp(props: {
  initial: PanelContext;
  bearer: string;
  identity: Identity;
  texts: Texts;
  theme: "light" | "dark";
  adminUrl: string;
  apiBase: string;
}) {
  const { texts, identity, apiBase } = props;
  const t = useCallback((key: string, vars?: Record<string, string | number>) => formatText(texts[key] ?? key, vars), [texts]);

  const [ctx, setCtx] = useState(props.initial);
  const bearer = useRef(props.bearer);
  const rootRef = useRef<HTMLElement>(null);

  const initialEvent = ctx.events.find((e) => firstOpen(e)) ?? ctx.events[0];
  const initialSlot = firstOpen(initialEvent);
  const [eventId, setEventId] = useState(initialEvent?.id ?? "");
  const [day, setDay] = useState<string | null>(initialSlot?.dayKey ?? null);
  const [selected, setSelected] = useState<string[]>(initialSlot ? [initialSlot.id] : []);
  const [seats, setSeats] = useState(1);
  const [attendees, setAttendees] = useState<{ name: string; email: string }[]>([]);
  const [inviteGuests, setInviteGuests] = useState(false);
  const [action, setAction] = useState<"book" | "link" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const event = ctx.events.find((e) => e.id === eventId) ?? ctx.events[0];
  const slots = useMemo(() => event?.slots ?? [], [event]);

  // --- Pipedrive SDK (nur im iframe mit Kennung) -----------------------
  const sdk = usePipedriveSdk(rootRef);

  // --- API mit Sitzungserneuerung --------------------------------------
  const renew = useCallback(async (): Promise<boolean> => {
    if (!sdk.current) return false;
    try {
      const r = (await sdk.current.execute("get_signed_token")) as { token?: string };
      if (!r?.token) return false;
      const res = await fetch(`${apiBase}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: r.token, ...identity }),
      });
      const body = (await res.json()) as { ok: boolean; bearer?: string };
      if (!body.ok || !body.bearer) return false;
      bearer.current = body.bearer;
      return true;
    } catch {
      return false;
    }
  }, [apiBase, identity]);

  const api = useCallback(
    async <T,>(path: string, init?: RequestInit, retried = false): Promise<{ ok: true; data: T } | { ok: false; message: string }> => {
      try {
        const res = await fetch(`${apiBase}${path}`, {
          ...init,
          headers: { ...(init?.headers ?? {}), authorization: `Bearer ${bearer.current}`, "content-type": "application/json" },
          cache: "no-store",
        });
        if (res.status === 401 && !retried && (await renew())) return api<T>(path, init, true);
        const body = (await res.json()) as { ok: boolean; message?: string } & T;
        return body.ok ? { ok: true, data: body } : { ok: false, message: body.message ?? t("panel.error.generic") };
      } catch {
        return { ok: false, message: t("panel.error.generic") };
      }
    },
    [apiBase, renew, t],
  );

  const refresh = useCallback(async () => {
    const r = await api<{ context: PanelContext }>("/context");
    if (r.ok) {
      setCtx(r.data.context);
      setError(null);
      // Versand ist entschieden -> Hinweis "wird gesendet" durch den Status ersetzen
      if (r.data.context.invitation?.mail?.status === "failed" || r.data.context.invitation?.mail?.status === "sent") setNotice(null);
    } else setError(r.message);
    return r.ok ? r.data.context : null;
  }, [api]);

  // Versandstatus nachladen, solange die Mail unterwegs ist
  const mailPending = ctx.invitation?.mail && (ctx.invitation.mail.status === "queued" || ctx.invitation.mail.status === "sending");
  const polls = useRef(0);
  useEffect(() => {
    if (!mailPending || polls.current > 20) return;
    const id = setTimeout(() => {
      polls.current += 1;
      void refresh();
    }, 3000);
    return () => clearTimeout(id);
  }, [mailPending, ctx, refresh]);

  // --- Auswahl -----------------------------------------------------------
  // Nur Tage, an denen das Event tatsächlich Termine hat (Slots sind nach Beginn sortiert)
  const eventDays = [...new Set(slots.map((s) => s.dayKey))];
  const slotsOn = (key: string) => slots.filter((s) => s.dayKey === key);
  const thisYear = ctx.todayKey.slice(0, 4);

  const pickEvent = (id: string) => {
    const ev = ctx.events.find((e) => e.id === id);
    const s = firstOpen(ev);
    setEventId(id);
    setDay(s?.dayKey ?? null);
    setSelected(s ? [s.id] : []);
    setSeats(1);
    setAttendees([]);
    setInviteGuests(false);
  };
  const toggleSlot = (s: PanelSlot) => {
    if (s.free <= 0) return;
    setSelected([s.id]);
    setSeats((n) => Math.min(Math.max(1, n), s.free));
  };

  const label = (s: PanelSlot) => `${s.weekdayShort}, ${s.date} · ${s.time}`;

  // --- Status ------------------------------------------------------------
  const inv = ctx.invitation;
  const status = (() => {
    if (!inv) return { kind: "none", text: t("panel.status.none") };
    if (inv.status === "booked" && inv.booking) return { kind: "booked", text: t("panel.status.booked", inv.booking) };
    if (inv.status === "cancelled") return { kind: "warn", text: t("panel.status.cancelled") };
    if (inv.mail?.status === "failed") return { kind: "error", text: t("panel.status.failed") };
    if (inv.mail && inv.mail.status !== "sent") return { kind: "pending", text: t("panel.status.queued") };
    if (inv.expired) return { kind: "warn", text: t("panel.status.expired") };
    const date = new Intl.DateTimeFormat("de-AT", { timeZone: ctx.timezone, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(inv.createdAt));
    return { kind: "sent", text: t("panel.status.sent", { date }) };
  })();
  const mailFailure = inv?.mail?.status === "failed" ? t(`mailError.${inv.mail.code ?? "generic"}`) : null;
  const mailFailureText = mailFailure?.startsWith("mailError.") ? t("mailError.generic") : mailFailure;

  // --- Direkt buchen / Link senden ----------------------------------------
  const chosen = slots.find((x) => x.id === selected[0]) ?? null;
  const alreadyBooked = inv?.status === "booked";
  const hasContact = !!ctx.person?.email;
  const canBook = !!event && hasContact && !busy && !!chosen && chosen.free > 0 && seats >= 1 && seats <= chosen.free && !alreadyBooked;
  const canLink = !!event && hasContact && !busy && !alreadyBooked && slots.some((x) => x.free > 0);

  const done = (msg: string) => {
    setNotice(msg);
    polls.current = 0;
    void sdk.current?.execute("show_snackbar", { message: msg }).catch(() => {});
    void refresh();
  };

  /** Termin direkt für den Kontakt buchen – der Kunde erhält die Bestätigung */
  const book = async () => {
    setError(null);
    setNotice(null);
    if (!chosen) return setError(t("panel.nothingSelected"));
    setBusy(true);
    setAction("book");
    const rows = attendees.slice(0, seats - 1);
    const r = await api<{ email: string }>("/book", {
      method: "POST",
      body: JSON.stringify({ slotId: chosen.id, seats, attendees: rows, inviteGuests: inviteGuests && seats > 1 }),
    });
    setBusy(false);
    setAction(null);
    if (!r.ok) return setError(r.message);
    setAttendees([]);
    setInviteGuests(false);
    done(t("panel.bookedOk", { date: label(chosen), seats, email: r.data.email }));
  };

  /** Buchungslink senden: der Kunde wählt selbst aus allen Terminen des Events */
  const sendLink = async () => {
    setError(null);
    setNotice(null);
    if (!event) return;
    setBusy(true);
    setAction("link");
    const r = await api<{ email: string }>("/invite", { method: "POST", body: JSON.stringify({ eventId: event.id, slotIds: null }) });
    setBusy(false);
    setAction(null);
    if (!r.ok) return setError(r.message);
    done(t("panel.sentOk", { email: r.data.email }));
  };

  const copy = async () => {
    if (!inv?.link) return;
    try {
      await navigator.clipboard.writeText(inv.link);
    } catch {
      const el = document.getElementById("panel-link") as HTMLInputElement | null;
      el?.select();
      document.execCommand?.("copy");
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const daySlots = day ? slotsOn(day) : [];

  return (
    <main ref={rootRef} className={styles.root} data-theme={props.theme}>
      <div className={styles.head}>
        <h1 className={styles.title}>{t("panel.title")}</h1>
        <button type="button" className={styles.iconBtn} onClick={() => void refresh()} aria-label={t("panel.refresh")} title={t("panel.refresh")}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />
          </svg>
        </button>
      </div>

      <section className={styles.card} aria-label={ctx.person?.name ?? undefined}>
        {ctx.person ? (
          <>
            <div className={styles.contactRow}>
              <strong className={styles.contactName}>{ctx.person.name}</strong>
              <span className={`${styles.pill} ${styles[`pill_${status.kind}`]}`} role="status">
                <span className={styles.dot} aria-hidden="true" />
                {status.text}
              </span>
            </div>
            <div className={styles.muted}>{ctx.person.email ?? t("panel.noContact")}</div>
            {ctx.person.organization && <div className={styles.muted}>{ctx.person.organization}</div>}
          </>
        ) : (
          <p className={styles.muted} style={{ margin: 0 }}>
            {t("panel.noContact")}
          </p>
        )}
        {mailFailureText && (
          <p role="alert" className={styles.alert}>
            {mailFailureText}
          </p>
        )}
      </section>

      {ctx.mailboxMissing && (
        <p role="alert" className={styles.alert}>
          {t("panel.mailboxMissing")}
        </p>
      )}

      {ctx.events.length === 0 ? (
        <p className={styles.card}>{t("panel.noEvents")}</p>
      ) : (
        <section className={styles.card}>
          <label htmlFor="panel-event" className={styles.label}>
            {t("panel.event")}
          </label>
          <select id="panel-event" className={styles.select} value={event?.id} onChange={(e) => pickEvent(e.target.value)}>
            {ctx.events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </select>

          {slots.length === 0 ? (
            <p className={styles.info}>{t("panel.noSlots")}</p>
          ) : (
            <div className={styles.picker}>
              <div className={styles.label}>{t("panel.pick")}</div>
              <div role="group" aria-label={t("panel.days")} className={styles.days}>
                {eventDays.map((k) => {
                  const list = slotsOn(k);
                  const full = !list.some((s) => s.free > 0);
                  const d = toDate(k);
                  const picked = list.some((s) => selected.includes(s.id));
                  const otherYear = k.slice(0, 4) !== thisYear;
                  const aria = `${fmt({ weekday: "long", day: "numeric", month: "long", ...(otherYear ? { year: "numeric" } : {}) }).format(d)}${full ? `, ${t("panel.day.full")}` : ""}`;
                  return (
                    <button
                      key={k}
                      type="button"
                      className={styles.day}
                      data-full={full}
                      data-picked={picked}
                      aria-pressed={day === k}
                      aria-label={aria}
                      onClick={() => setDay(k)}
                    >
                      <span className={styles.wd}>{fmt({ weekday: "short" }).format(d).replace(".", "").toUpperCase()}</span>
                      <span className={styles.num}>{d.getUTCDate()}</span>
                      <span className={styles.sub}>{full ? t("panel.day.fullShort") : fmt({ month: "short", ...(otherYear ? { year: "2-digit" } : {}) }).format(d)}</span>
                    </button>
                  );
                })}
              </div>
              {day && daySlots.length > 0 && (
                <div className={styles.times}>
                  <div className={styles.label}>{t("panel.time")}</div>
                  {daySlots.map((s) => {
                    const full = s.free <= 0;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        className={styles.time}
                        data-full={full}
                        aria-pressed={selected.includes(s.id)}
                        disabled={full}
                        onClick={() => toggleSlot(s)}
                      >
                        <span className={styles.range}>
                          {s.time}
                          {s.location ? <span className={styles.loc}> · {s.location}</span> : null}
                        </span>
                        <span className={styles.free} data-level={full ? "full" : s.free <= 3 ? "low" : "ok"}>
                          {full ? t("panel.full") : t("panel.free", { free: s.free, capacity: s.capacity })}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className={styles.hint}>{tzLabel(ctx.timezone)}</div>
            </div>
          )}

          {chosen && chosen.free > 0 && (
            <div className={styles.seatsRow}>
              <label htmlFor="panel-seats" className={styles.label}>
                {t("panel.seats")}
              </label>
              <input
                id="panel-seats"
                className={styles.seatsInput}
                type="number"
                min={1}
                max={chosen.free}
                value={seats}
                onChange={(e) => setSeats(Math.max(1, Math.min(chosen.free, Number(e.target.value) || 1)))}
              />
            </div>
          )}

          {chosen && chosen.free > 0 && seats > 1 && (
            <fieldset className={styles.guests}>
              <legend className={styles.label}>{t("panel.guests.legend")}</legend>
              <label className={styles.checkRow}>
                <input type="checkbox" checked={inviteGuests} onChange={(e) => setInviteGuests(e.target.checked)} />
                <span>{t("panel.guests.invite")}</span>
              </label>
              {inviteGuests && <div className={styles.hint}>{t("panel.guests.hint")}</div>}
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
                    <input
                      className={styles.select}
                      aria-label={t("panel.guests.name", { n: i + 2 })}
                      placeholder={t("panel.guests.name", { n: i + 2 })}
                      value={row.name}
                      maxLength={200}
                      onChange={(e) => update({ name: e.target.value })}
                    />
                    {inviteGuests && (
                      <input
                        className={styles.select}
                        type="email"
                        aria-label={t("panel.guests.email", { n: i + 2 })}
                        placeholder={t("panel.guests.email", { n: i + 2 })}
                        value={row.email}
                        maxLength={254}
                        onChange={(e) => update({ email: e.target.value })}
                      />
                    )}
                  </div>
                );
              })}
            </fieldset>
          )}

          <div className={styles.sendRow}>
            <button type="button" className={styles.sendBtn} onClick={() => void book()} disabled={!canBook} aria-describedby="panel-book-hint">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <rect x="3" y="5" width="18" height="16" rx="2" />
                <path d="M3 10h18M8 3v4M16 3v4M9 15l2 2 4-4" />
              </svg>
              {action === "book" ? t("panel.booking") : t("panel.book")}
            </button>
          </div>
          <div id="panel-book-hint" className={styles.hint}>
            {alreadyBooked ? t("panel.alreadyBookedHint") : chosen ? t("panel.bookHint", { date: label(chosen), email: ctx.person?.email ?? "—" }) : t("panel.nothingSelected")}
          </div>

          <div className={styles.orRow} aria-hidden="true">
            <span>{t("panel.or")}</span>
          </div>
          <button type="button" className={styles.linkSendBtn} onClick={() => void sendLink()} disabled={!canLink} aria-describedby="panel-send-hint">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M4 6h16v12H4z" />
              <path d="m4 7 8 6 8-6" />
            </svg>
            {action === "link" ? t("panel.sending") : t("panel.sendLink")}
          </button>
          <div id="panel-send-hint" className={styles.hint}>
            {t("panel.linkInfo")}
            {inv && inv.status === "open" ? ` ${t("panel.resendHint")}` : null}
          </div>
          {error && (
            <p role="alert" className={styles.alert}>
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className={styles.ok}>
              {notice}
            </p>
          )}
        </section>
      )}

      <section className={styles.card}>
        <div className={styles.label}>{t("panel.link.title")}</div>
        {inv?.link && inv.status !== "revoked" ? (
          <div className={styles.linkRow}>
            <label htmlFor="panel-link" className={styles.visuallyHidden}>
              {t("panel.link.title")}
            </label>
            <input id="panel-link" className={styles.linkInput} value={inv.link} readOnly onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className={styles.copyBtn} onClick={() => void copy()} aria-live="polite">
              {copied ? t("panel.link.copied") : t("panel.link.copy")}
            </button>
          </div>
        ) : (
          <p className={styles.muted}>{t("panel.link.none")}</p>
        )}
        <div className={styles.hint}>{t("panel.link.hint")}</div>
      </section>

      <a href={props.adminUrl} target="_blank" rel="noopener noreferrer" className={styles.adminLink}>
        <span className={styles.adminIcon} aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 6h16M4 12h16M4 18h10" />
          </svg>
        </span>
        <span className={styles.adminText}>
          <strong>{t("panel.admin.title")}</strong>
          <span className={styles.muted}>{t("panel.admin.sub")}</span>
        </span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
      </a>

      <div className={styles.totals}>
        <span>{t("panel.totals")}</span>
        <span>
          <strong>{ctx.totals.free}</strong> <span className={styles.muted}>{t("panel.totalsOf", { n: ctx.totals.capacity })}</span>
        </span>
      </div>
    </main>
  );
}
