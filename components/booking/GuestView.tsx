/**
 * Link eines weiteren Teilnehmers: Termin ansehen und in den Kalender
 * übernehmen. Kein Absagen über den Link – bei Verhinderung an den
 * Ansprechpartner wenden (die Hemmschwelle zum Nicht-Kommen soll hoch sein).
 */
import { formatText, type ResolvedTexts, type TextKey } from "@/lib/texts";
import styles from "./Booking.module.css";

type Props = {
  texts: ResolvedTexts;
  eventTitle: string;
  guestName: string;
  booker: string;
  /** active = angemeldet, ended = Buchung oder Teilnahme nicht mehr aktiv */
  state: "active" | "ended";
  when: { weekday: string; date: string; time: string; location: string | null };
  contactName: string | null;
  googleUrl: string;
  outlookUrl: string;
};

export function GuestView(props: Props) {
  const { texts, when } = props;
  const t = (key: TextKey, vars?: Record<string, string | number>) => formatText(texts[key], vars);

  if (props.state !== "active") {
    return (
      <main className={`tb-container ${styles.message}`}>
        <h1>{t("guest.bookingEnded.title")}</h1>
        <p>{t("guest.bookingEnded.text")}</p>
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

      <p className={styles.contactNote}>{props.contactName ? t("done.contact", { name: props.contactName }) : t("done.contactFallback")}</p>
    </main>
  );
}
