import { at } from "@/lib/texts/admin";
import { formatDateTime } from "@/lib/datetime";
import type { MailboxView, MailScope } from "@/lib/mail/connect";
import { devConnectAction, disconnectAction, saveSmtpAction, sendTestAction } from "@/app/admin/(app)/postfach/actions";
import styles from "./Admin.module.css";

type Props = {
  scope: MailScope;
  mailbox: MailboxView | null;
  /** Welche OAuth-Apps sind eingerichtet? */
  providers: { google: boolean; microsoft: boolean };
  dev: boolean;
  timezone: string;
  /** SMTP-Formular anzeigen (nur für Postfächer, die per SMTP angebunden werden) */
  showSmtp?: boolean;
};

const LEVEL: Record<MailboxView["status"], string> = { active: "lvl_ok", pending: "lvl_low", error: "lvl_full", revoked: "lvl_closed" };

/** Ein Postfach (eigenes oder Firmenpostfach): Status, Verbinden, Testen, Trennen */
export function MailboxCard({ scope, mailbox, providers, dev, timezone, showSmtp = false }: Props) {
  const p = `mb-${scope}`;
  return (
    <div className={styles.mailbox}>
      {mailbox ? (
        <div className={styles.mailboxStatus}>
          <div>
            <strong>{mailbox.senderEmail}</strong>
            <span className={styles.tag}>{at(`mailbox.provider.${mailbox.provider}`)}</span>
          </div>
          <span className={`${styles.badge} ${styles[LEVEL[mailbox.status]]}`}>{at(`mailbox.status.${mailbox.status}`)}</span>
        </div>
      ) : (
        <p className={styles.muted} style={{ margin: 0 }}>
          {at("mailbox.none")}
        </p>
      )}

      {mailbox?.status === "pending" && <p className={styles.info}>{at("mailbox.pendingHint", { email: mailbox.senderEmail })}</p>}
      {mailbox?.status === "error" && (
        <p className={styles.error} role="alert">
          {at("mailbox.errorHint", { reason: mailbox.lastError ?? "—" })}
        </p>
      )}
      {mailbox?.lastVerifiedAt && <p className={styles.hint}>{at("mailbox.verifiedAt", { date: formatDateTime(mailbox.lastVerifiedAt, timezone) })}</p>}

      <div className={styles.actions}>
        {(["google", "microsoft"] as const)
          .filter((prov) => providers[prov])
          .map((prov) => (
            <a key={prov} className={mailbox ? styles.btnGhost : styles.btn} href={`/api/mail/oauth/${prov}/start?scope=${scope}`}>
              {mailbox?.provider === prov ? at("mailbox.reconnect") : at(prov === "google" ? "mailbox.connectGoogle" : "mailbox.connectMicrosoft")}
            </a>
          ))}
        {mailbox && (
          <>
            <form action={sendTestAction}>
              <input type="hidden" name="id" value={mailbox.id} />
              <input type="hidden" name="scope" value={scope} />
              <button type="submit" className={styles.btnGhost}>
                {at("mailbox.test")}
              </button>
            </form>
            <form action={disconnectAction}>
              <input type="hidden" name="id" value={mailbox.id} />
              <input type="hidden" name="scope" value={scope} />
              <button type="submit" className={styles.btnDanger}>
                {at("mailbox.disconnect")}
              </button>
            </form>
          </>
        )}
        {dev && (
          <form action={devConnectAction}>
            <input type="hidden" name="scope" value={scope} />
            <button type="submit" className={styles.btnGhost}>
              {at("mailbox.devConnect")}
            </button>
          </form>
        )}
      </div>

      {showSmtp && (
      <details className={styles.details} open={!mailbox && !providers.google && !providers.microsoft}>
        <summary>{at("mailbox.smtp.summary")}</summary>
        <p className={styles.hint}>{at("mailbox.smtp.hint")}</p>
        <form action={saveSmtpAction} className={styles.form} autoComplete="off">
          <input type="hidden" name="scope" value={scope} />
          <div className={styles.field}>
            <label htmlFor={`${p}-email`}>{at("mailbox.smtp.senderEmail")}</label>
            <input id={`${p}-email`} name="senderEmail" type="email" required maxLength={320} defaultValue={mailbox?.provider === "smtp" ? mailbox.senderEmail : ""} />
          </div>
          <div className={styles.field}>
            <label htmlFor={`${p}-name`}>{at("mailbox.smtp.senderName")}</label>
            <input id={`${p}-name`} name="senderName" type="text" maxLength={200} defaultValue={mailbox?.senderName ?? ""} />
          </div>
          <div className={styles.field}>
            <label htmlFor={`${p}-host`}>{at("mailbox.smtp.host")}</label>
            <input id={`${p}-host`} name="host" type="text" required placeholder="smtp.example.com" />
          </div>
          <div className={styles.field}>
            <label htmlFor={`${p}-port`}>{at("mailbox.smtp.port")}</label>
            <input id={`${p}-port`} name="port" type="number" min={1} max={65535} required defaultValue={587} />
          </div>
          <div className={`${styles.field} ${styles.full}`}>
            <label htmlFor={`${p}-sec`}>{at("mailbox.smtp.security")}</label>
            <select id={`${p}-sec`} name="secure" defaultValue="starttls">
              <option value="starttls">{at("mailbox.smtp.starttls")}</option>
              <option value="tls">{at("mailbox.smtp.tls")}</option>
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor={`${p}-user`}>{at("mailbox.smtp.user")}</label>
            <input id={`${p}-user`} name="user" type="text" required autoComplete="off" />
          </div>
          <div className={styles.field}>
            <label htmlFor={`${p}-pass`}>{at("mailbox.smtp.pass")}</label>
            <input id={`${p}-pass`} name="pass" type="password" required autoComplete="new-password" />
          </div>
          <div className={styles.full}>
            <button type="submit" className={styles.btn}>
              {at("mailbox.smtp.submit")}
            </button>
          </div>
        </form>
      </details>
      )}
    </div>
  );
}
