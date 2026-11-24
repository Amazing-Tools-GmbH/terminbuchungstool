import { requireAdmin } from "@/lib/auth/admin";
import { loadMailSettings } from "@/lib/mail/connect";
import { systemMailConfig } from "@/lib/mail/config";
import { flashMessages } from "@/lib/admin/messages";
import { formatDateTime } from "@/lib/datetime";
import { at, mailErrorText } from "@/lib/texts/admin";
import styles from "@/components/admin/Admin.module.css";
import { saveMailRouteAction, saveSmartBccAction } from "../postfach/actions";

type Search = Promise<Record<string, string | string[] | undefined>>;
const MB_LEVEL = { active: "lvl_ok", pending: "lvl_low", error: "lvl_full", revoked: "lvl_closed" } as const;

export default async function MailSettingsPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const s = await loadMailSettings(ctx);
  const { ok, error } = flashMessages(await searchParams);
  const tz = ctx.tenant.timezone;
  const system = systemMailConfig();
  const employee = s.mailRoute === "employee";
  const missing = s.team.filter((m) => m.mailbox?.status !== "active");

  return (
    <>
      <h1 className={styles.h1}>{at("mailSettings.title")}</h1>
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
                    {r === "system" ? at("mailSettings.routes.system.text", { email: system?.fromEmail ?? "—" }) : at("mailSettings.routes.employee.text")}
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
            {at("mailSettings.routes.employeeMissing", { names: missing.map((m) => m.name).join(", ") })}
          </p>
        )}
        <p className={styles.hint}>{at("mailSettings.routes.hint")}</p>
      </section>

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
                  <strong>{f.toEmail}</strong> <span className={styles.tag}>{at(`mailSettings.failed.type.${f.type as "invitation" | "confirmation" | "cancellation"}`)}</span>
                  <div className={styles.hint}>{mailErrorText(f.code)}</div>
                </div>
                <span className={styles.nowrap}>{formatDateTime(f.at, tz)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
