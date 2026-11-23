"use client";
/**
 * Link eines weiteren Teilnehmers: Termin ansehen, in den Kalender
 * übernehmen und NUR für sich absagen (die ganze Buchung verwaltet der
 * Hauptbucher über seinen eigenen Link).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatText, type ResolvedTexts, type TextKey } from "@/lib/texts";
import styles from "./Booking.module.css";

type Props = {
  token: string;
  texts: ResolvedTexts;
  eventTitle: string;
  guestName: string;
  booker: string;
  /** active = angemeldet, declined = selbst abgesagt, ended = Buchung storniert/geändert */
  state: "active" | "declined" | "ended";
  when: { weekday: string; date: string; time: string; location: string | null };
  canDecline: boolean;
  declineUntil: string;
  googleUrl: string;
  outlookUrl: string;
};

export function GuestView(props: Props) {
  const { texts, when } = props;
  const t = (key: TextKey, vars?: Record<string, string | number>) => formatText(texts[key], vars);
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decline() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/bookings/guest-cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: props.token }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!res.ok || !data.ok) {
        setError(data.message ?? t("error.generic"));
        return;
      }
      router.refresh();
    } catch {
      setError(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  if (props.state !== "active") {
    const ended = props.state === "ended";
    return (
      <main className={`tb-container ${styles.message}`}>
        <h1>{t(ended ? "guest.bookingEnded.title" : "guest.declined.title")}</h1>
        <p>{ended ? t("guest.bookingEnded.text") : t("guest.declined.text", { booker: props.booker })}</p>
      </main>
    );
  }

  return (
    <main className={`tb-container ${styles.done}`}>
      <div className={styles.doneIcon} aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="m5 12 5 5 9-10" />
        </svg>
      </div>
      <div>
        <p className={styles.muted}>{props.eventTitle}</p>
        <h1 className={styles.doneTitle}>{t("guest.title")}</h1>
        <p className={styles.doneText}>
          {t("mail.greeting", { name: props.guestName })} {t("guest.text", { booker: props.booker })}
        </p>
      </div>

      <dl className={styles.summary}>
        <div>
          <dt>{t("done.date")}</dt>
          <dd>
            {when.weekday}, {when.date}
          </dd>
        </div>
        <div>
          <dt>{t("done.time")}</dt>
          <dd>{when.time}</dd>
        </div>
        {when.location && (
          <div>
            <dt>{t("done.place")}</dt>
            <dd>{when.location}</dd>
          </div>
        )}
      </dl>

      <div className={styles.calendarRow}>
        <a className={styles.secondaryLink} href={props.googleUrl} target="_blank" rel="noopener noreferrer">
          {t("done.google")}
        </a>
        <a className={styles.secondaryLink} href={props.outlookUrl} target="_blank" rel="noopener noreferrer">
          {t("done.outlook")}
        </a>
      </div>

      {props.canDecline ? (
        <div className={styles.changeArea}>
          <p className={styles.muted}>{t("guest.declineUntil", { until: props.declineUntil })}</p>
          <div className={styles.changeActions}>
            {!confirm ? (
              <button type="button" className={styles.linkButtonMuted} onClick={() => setConfirm(true)}>
                {t("guest.decline")}
              </button>
            ) : (
              <span className={styles.confirmBox} role="group" aria-label={t("guest.decline")}>
                <span>{t("guest.declineConfirm")}</span>
                <button type="button" className={styles.dangerButton} onClick={decline} disabled={busy}>
                  {t("guest.declineYes")}
                </button>
                <button type="button" className={styles.linkButtonMuted} onClick={() => setConfirm(false)} disabled={busy}>
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
        <p className={styles.muted}>{t("guest.deadlinePassed", { booker: props.booker })}</p>
      )}
    </main>
  );
}
