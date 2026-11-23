"use client";
/**
 * Vertriebs-Panel im Pipedrive-Deal: Kontakt mit Status, Event wählen, dessen
 * Termine mit freien Plätzen, Buchungslink senden (gilt für alle kommenden Termine
 * des Events), persönlicher Link, freie Plätze. Läuft im iframe von Pipedrive;
 * das SDK wird nur dort initialisiert (Größe anpassen, Hinweise, Sitzung erneuern).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelContext, PanelEvent, PanelSlot } from "@/lib/panel/context";
import { formatText } from "@/lib/texts";
import styles from "./Panel.module.css";
import { usePipedriveSdk } from "./usePipedriveSdk";

type Texts = Record<string, string>;
type Identity = { userId: number; companyId: number; dealId: number };
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
  const [eventId, setEventId] = useState(initialEvent?.id ?? "");
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

  // --- Event & Plätze --------------------------------------------------
  const openSlots = slots.filter((s) => s.free > 0).length;
  const eventTotals = slots.reduce((acc, s) => ({ free: acc.free + s.free, capacity: acc.capacity + s.capacity }), { free: 0, capacity: 0 });

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

  // --- Senden ------------------------------------------------------------
  const canSend = !!event && !!ctx.person?.email && !busy && openSlots > 0;
  const send = async () => {
    setError(null);
    setNotice(null);
    if (!event) return;
    setBusy(true);
    const r = await api<{ email: string }>("/invite", {
      method: "POST",
      // Link gilt für das ganze Event: alle kommenden Termine
      body: JSON.stringify({ eventId: event.id, slotIds: null }),
    });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    const msg = t("panel.sentOk", { email: r.data.email });
    setNotice(msg);
    polls.current = 0;
    void sdk.current?.execute("show_snackbar", { message: msg }).catch(() => {});
    void refresh();
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

      {ctx.events.length === 0 ? (
        <p className={styles.card}>{t("panel.noEvents")}</p>
      ) : (
        <section className={styles.card}>
          <label htmlFor="panel-event" className={styles.label}>
            {t("panel.event")}
          </label>
          <select id="panel-event" className={styles.select} value={event?.id} onChange={(e) => setEventId(e.target.value)}>
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
              <div className={styles.label}>{t("panel.dates")}</div>
              <ul className={styles.dateList}>
                {slots.map((s) => {
                  const full = s.free <= 0;
                  return (
                    <li key={s.id} className={styles.dateItem} data-full={full}>
                      <span className={styles.range}>
                        {s.weekdayShort}, {s.date} · {s.time}
                        {s.location ? <span className={styles.loc}> · {s.location}</span> : null}
                      </span>
                      <span className={styles.free} data-level={full ? "full" : s.free <= 3 ? "low" : "ok"}>
                        {full ? t("panel.full") : t("panel.free", { free: s.free, capacity: s.capacity })}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <div className={styles.hint}>{t("panel.timezone", { tz: ctx.timezone })}</div>
            </div>
          )}

          <div className={styles.sendRow}>
            <button type="button" className={styles.sendBtn} onClick={() => void send()} disabled={!canSend} aria-describedby="panel-send-hint">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M4 6h16v12H4z" />
                <path d="m4 7 8 6 8-6" />
              </svg>
              {busy ? t("panel.sending") : inv ? t("panel.resend") : t("panel.send")}
            </button>
          </div>
          <div id="panel-send-hint" className={styles.hint}>
            {t("panel.linkInfo")}
            {ctx.person?.email ? ` ${t("panel.sendTo", { email: ctx.person.email })}` : null}
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
          <strong>{eventTotals.free}</strong> <span className={styles.muted}>{t("panel.totalsOf", { n: eventTotals.capacity })}</span>
        </span>
      </div>
    </main>
  );
}
