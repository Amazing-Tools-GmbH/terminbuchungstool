import { requireAdmin } from "@/lib/auth/admin";
import { loadMailSettings } from "@/lib/mail/connect";
import { inviteMailProvider, systemMailConfig } from "@/lib/mail/config";
import { flashMessages } from "@/lib/admin/messages";
import { formatDateTime } from "@/lib/datetime";
import { at, mailErrorText } from "@/lib/texts/admin";
import styles from "@/components/admin/Admin.module.css";
import { saveConfirmationRouteAction, saveSmartBccAction } from "../postfach/actions";

type Search = Promise<Record<string, string | string[] | undefined>>;
const PD_LEVEL = { ready: "lvl_ok", missing_scope: "lvl_low", error: "lvl_full", none: "lvl_closed" } as const;
const MB_LEVEL = { active: "lvl_ok", pending: "lvl_low", error: "lvl_full", revoked: "lvl_closed" } as const;

export default async function MailSettingsPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const s = await loadMailSettings(ctx);
  const { ok, error } = flashMessages(await searchParams);
  const tz = ctx.tenant.timezone;
  const mode = inviteMailProvider();
  const system = systemMailConfig();

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
        <ul className={styles.list}>
          <li>
            <strong>{at("mailSettings.routes.invite")}</strong>
            <span>{mode === "smtp" ? at("mailSettings.routes.smtp", { email: system?.fromEmail ?? "—" }) : at(`mailSettings.routes.${mode}`)}</span>
          </li>
          <li>
            <strong>{at("mailSettings.routes.confirm")}</strong>
            {s.confirmationRoute === "pipedrive" ? (
              <span>{at("mailSettings.routes.confirmPipedrive")}</span>
            ) : (
              <span className={system ? undefined : styles.error}>
                {system ? at("mailSettings.routes.system", { email: system.fromEmail }) : at("mailSettings.routes.systemMissing")}
              </span>
            )}
          </li>
        </ul>
        <p className={styles.hint}>{at("mailSettings.routes.hint")}</p>
      </section>

      <section className={styles.card} aria-labelledby="confirm-route">
        <h2 className={styles.h2} id="confirm-route">
          {at("mailSettings.confirmRoute.title")}
        </h2>
        <form action={saveConfirmationRouteAction} className={styles.brandingFields}>
          <label className={styles.check} style={{ alignItems: "flex-start" }}>
            <input type="radio" name="route" value="pipedrive" defaultChecked={s.confirmationRoute === "pipedrive"} />
            <span>
              <strong>{at("mailSettings.confirmRoute.pipedrive")}</strong>
              <span className={styles.hint} style={{ display: "block" }}>
                {at("mailSettings.confirmRoute.pipedriveHint")}
              </span>
            </span>
          </label>
          <label className={styles.check} style={{ alignItems: "flex-start" }}>
            <input type="radio" name="route" value="system" defaultChecked={s.confirmationRoute === "system"} />
            <span>
              <strong>{at("mailSettings.confirmRoute.system", { email: system?.fromEmail ?? "—" })}</strong>
              <span className={styles.hint} style={{ display: "block" }}>
                {at("mailSettings.confirmRoute.systemHint")}
              </span>
            </span>
          </label>
          <p className={styles.hint} style={{ margin: 0 }}>
            {at("mailSettings.confirmRoute.noStaff")}
          </p>
          <div>
            <button type="submit" className={styles.btn}>
              {at("mailSettings.confirmRoute.save")}
            </button>
          </div>
        </form>
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
                    {mode === "pipedrive" ? (
                      <span className={`${styles.badge} ${styles[PD_LEVEL[m.pipedrive.state]]}`} title={m.pipedrive.lastError ?? undefined}>
                        {at(`mailbox.state.${m.pipedrive.state}`)}
                      </span>
                    ) : mode === "oauth" ? (
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
        {s.failedInvitations.length === 0 ? (
          <p className={styles.muted}>{at("mailSettings.failed.none")}</p>
        ) : (
          <ul className={styles.list}>
            {s.failedInvitations.map((f, i) => (
              <li key={i}>
                <div>
                  <strong>{f.toEmail}</strong>
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
