import Link from "next/link";
import { canManage, requireAdmin } from "@/lib/auth/admin";
import { loadMailSettings, loadMyMailbox } from "@/lib/mail/connect";
import { oauthProvidersVisible, systemMailConfig } from "@/lib/mail/config";
import { devToolsEnabled } from "@/lib/dev-tools";
import { flashMessages } from "@/lib/admin/messages";
import { formatDateTime } from "@/lib/datetime";
import { at, mailErrorText } from "@/lib/texts/admin";
import { MailboxCard } from "@/components/admin/MailboxCard";
import styles from "@/components/admin/Admin.module.css";
import { saveMailRouteAction, saveSignatureAction, saveSmartBccAction } from "./actions";

type Search = Promise<Record<string, string | string[] | undefined>>;
const MB_LEVEL = {
  active: "lvl_ok",
  pending: "lvl_low",
  error: "lvl_full",
  revoked: "lvl_closed",
} as const;

/**
 * E-Mail-Einstellungen (ein Menüpunkt für alle Rollen):
 *   alle         „Mein Postfach“ (eigenes Postfach, Testmail) + Signatur
 *   owner/admin  zusätzlich Versandweg, Smart BCC, Postfächer im Team, nicht versendete Mails
 */
export default async function MailSettingsPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireAdmin();
  const manage = canManage(ctx.role);
  const [my, s] = await Promise.all([loadMyMailbox(ctx), manage ? loadMailSettings(ctx) : null]);
  const { mine, mailRoute, signature } = my;
  const { ok, error } = flashMessages(await searchParams);
  const tz = ctx.tenant.timezone;
  const system = systemMailConfig();
  const providers = oauthProvidersVisible();
  const employee = mailRoute === "employee";
  const missing = s ? s.team.filter((m) => m.mailbox?.status !== "active") : [];

  return (
    <>
      <div>
        <h1 className={styles.h1}>{at("mailSettings.title")}</h1>
        <p className={styles.muted} style={{ maxWidth: 760 }}>
          {employee ? at("mailbox.intro.employee") : at("mailbox.intro.system", { email: system?.fromEmail ?? "—" })}
        </p>
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

      {employee && mine?.status !== "active" && (
        <p role="alert" className={styles.error}>
          {at("mailbox.employee.missing")}
        </p>
      )}

      {s && (
        <section className={styles.card} aria-labelledby="routes">
          <h2 className={styles.h2} id="routes">
            {at("mailSettings.routes.title")}
          </h2>
          <form action={saveMailRouteAction} className={styles.form}>
            <fieldset className={`${styles.field} ${styles.full}`} style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className={styles.muted} style={{ marginBottom: 8 }}>
                {at("mailSettings.routes.intro")}
              </legend>
              {(["system", "employee"] as const).map((r) => (
                <label key={r} className={styles.radioCard}>
                  <input type="radio" name="mailRoute" value={r} defaultChecked={s.mailRoute === r} />
                  <span>
                    <strong>{at(`mailSettings.routes.${r}.label`)}</strong>
                    <span className={styles.hint} style={{ display: "block", fontWeight: 400 }}>
                      {r === "system"
                        ? at("mailSettings.routes.system.text", {
                            email: system?.fromEmail ?? "—",
                          })
                        : at("mailSettings.routes.employee.text")}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className={styles.full}>
              <button type="submit" className={styles.btn}>
                {at("mailSettings.routes.submit")}
              </button>
            </div>
          </form>
          {!employee && !system && <p className={styles.error}>{at("mailSettings.routes.systemMissing")}</p>}
          {employee && missing.length > 0 && (
            <p role="alert" className={styles.error}>
              {at("mailSettings.routes.employeeMissing", {
                names: missing.map((m) => m.name).join(", "),
              })}
            </p>
          )}
          <p className={styles.hint}>{at("mailSettings.routes.hint")}</p>
        </section>
      )}

      {(employee || mine) && (
        <section className={styles.card} aria-labelledby="send-title">
          <h2 className={styles.h2} id="send-title">
            {at("mailbox.send.title")}
          </h2>
          {!employee && <p className={styles.info}>{at("mailbox.employee.inactive")}</p>}
          <MailboxCard scope="user" mailbox={mine} providers={providers} dev={devToolsEnabled()} timezone={tz} showSmtp />
        </section>
      )}

      <section className={styles.card} aria-labelledby="sig-title">
        <h2 className={styles.h2} id="sig-title">
          {at("mailbox.signature.title")}
        </h2>
        <p className={styles.muted} style={{ marginTop: 0 }}>
          {at("mailbox.signature.hint")}
        </p>
        <form action={saveSignatureAction} className={styles.form}>
          <div className={`${styles.field} ${styles.full}`}>
            <label htmlFor="signature">{at("mailbox.signature.label")}</label>
            <textarea id="signature" name="signature" rows={5} maxLength={2000} defaultValue={signature} className={styles.textarea} />
          </div>
          <div className={styles.full}>
            <button type="submit" className={styles.btn}>
              {at("mailbox.signature.submit")}
            </button>
          </div>
        </form>
      </section>

      {!employee && !manage && (
        <p className={system ? styles.info : styles.error}>
          {system ? at("mailbox.confirmInfo", { email: system.fromEmail }) : at("mailbox.confirmInfoMissing")}
        </p>
      )}

      {s && (
        <>
          <section className={styles.card} aria-labelledby="smart-bcc">
            <h2 className={styles.h2} id="smart-bcc">
              {at("mailSettings.smartBcc.title")}
            </h2>
            <p className={styles.muted} style={{ marginTop: 0 }}>
              {at("mailSettings.smartBcc.intro")}
            </p>
            <form action={saveSmartBccAction} className={styles.form}>
              <div className={`${styles.field} ${styles.full}`}>
                <label htmlFor="smart-bcc-input">{at("mailSettings.smartBcc.label")}</label>
                <input
                  id="smart-bcc-input"
                  name="smartBcc"
                  type="email"
                  maxLength={320}
                  defaultValue={s.smartBccEmail ?? ""}
                  placeholder="firma@pipedrivemail.com"
                  pattern=".+@(.+\.)?pipedrivemail\.com"
                  aria-describedby="smart-bcc-hint"
                />
                <span id="smart-bcc-hint" className={styles.hint}>
                  {at("mailSettings.smartBcc.hint")}
                </span>
              </div>
              <div className={styles.full}>
                <button type="submit" className={styles.btn}>
                  {at("mailSettings.smartBcc.submit")}
                </button>
              </div>
            </form>
          </section>

          <section aria-labelledby="team-mailboxes">
            <h2 className={styles.h2} id="team-mailboxes">
              {at("mailSettings.team.title")}
            </h2>
            <div className={styles.tableCard}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">{at("mailSettings.team.name")}</th>
                    <th scope="col">{at("mailSettings.team.ready")}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.team.map((m) => (
                    <tr key={m.userId}>
                      <td>
                        <strong>{m.name}</strong> <span className={styles.tag}>{at(`role.${m.role as "owner" | "admin" | "sales"}`)}</span>
                      </td>
                      <td data-label={at("mailSettings.team.ready")}>
                        {employee ? (
                          m.mailbox ? (
                            <>
                              {m.mailbox.senderEmail}{" "}
                              <span className={`${styles.badge} ${styles[MB_LEVEL[m.mailbox.status]]}`}>{at(`mailbox.status.${m.mailbox.status}`)}</span>
                            </>
                          ) : (
                            <span className={`${styles.badge} ${styles.lvl_closed}`}>{at("mailbox.none")}</span>
                          )
                        ) : (
                          at("mailSettings.team.viaSystem")
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className={styles.card} aria-labelledby="failed">
            <h2 className={styles.h2} id="failed">
              {at("mailSettings.failed.title")}
            </h2>
            {s.failedMails.length === 0 ? (
              <p className={styles.muted}>{at("mailSettings.failed.none")}</p>
            ) : (
              <ul className={styles.list}>
                {s.failedMails.map((f, i) => (
                  <li key={i}>
                    <div>
                      <strong>{f.toEmail}</strong>{" "}
                      <span className={styles.tag}>{at(`mailSettings.failed.type.${f.type as "invitation" | "confirmation" | "cancellation"}`)}</span>
                      <div className={styles.hint}>{mailErrorText(f.code)}</div>
                    </div>
                    <span className={styles.nowrap}>{formatDateTime(f.at, tz)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className={styles.hint}>
              {at("mailSettings.failed.hint")} <Link href="/admin/verlauf?errors=1">{at("mailSettings.failed.toActivity")}</Link>
            </p>
          </section>
        </>
      )}
    </>
  );
}
