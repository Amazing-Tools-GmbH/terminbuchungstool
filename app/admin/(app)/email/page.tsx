import { requireAdmin } from "@/lib/auth/admin";
import { loadMailSettings } from "@/lib/mail/connect";
import { mailOAuthConfig } from "@/lib/mail/oauth";
import { devToolsEnabled } from "@/lib/dev-tools";
import { flashMessages } from "@/lib/admin/messages";
import { formatDateTime } from "@/lib/datetime";
import { at } from "@/lib/texts/admin";
import { MailboxCard } from "@/components/admin/MailboxCard";
import styles from "@/components/admin/Admin.module.css";
import { saveSmartBccAction } from "../postfach/actions";

type Search = Promise<Record<string, string | string[] | undefined>>;
const LEVEL = { active: "lvl_ok", pending: "lvl_low", error: "lvl_full", revoked: "lvl_closed" } as const;

export default async function MailSettingsPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const s = await loadMailSettings(ctx);
  const { ok, error } = flashMessages(await searchParams);
  const providers = { google: Boolean(mailOAuthConfig("google")), microsoft: Boolean(mailOAuthConfig("microsoft")) };
  const tz = ctx.tenant.timezone;

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

      <section className={styles.card} aria-labelledby="tenant-mailbox">
        <h2 className={styles.h2} id="tenant-mailbox">
          {at("mailbox.tenant.title")}
        </h2>
        <p className={styles.muted} style={{ marginTop: 0 }}>
          {at("mailbox.tenant.intro")}
        </p>
        <MailboxCard scope="tenant" mailbox={s.tenantMailbox} providers={providers} dev={devToolsEnabled()} timezone={tz} />
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
                <th scope="col">{at("mailSettings.team.mailbox")}</th>
                <th scope="col">{at("mailSettings.team.status")}</th>
              </tr>
            </thead>
            <tbody>
              {s.team.map((m) => (
                <tr key={m.userId}>
                  <td>
                    <strong>{m.name}</strong> <span className={styles.tag}>{at(`role.${m.role as "owner" | "admin" | "sales"}`)}</span>
                  </td>
                  <td data-label={at("mailSettings.team.mailbox")}>
                    {m.mailbox ? `${m.mailbox.senderEmail} (${at(`mailbox.provider.${m.mailbox.provider}`)})` : at("mailSettings.team.none")}
                  </td>
                  <td data-label={at("mailSettings.team.status")}>
                    {m.mailbox ? (
                      <span className={`${styles.badge} ${styles[LEVEL[m.mailbox.status]]}`} title={m.mailbox.lastError ?? undefined}>
                        {at(`mailbox.status.${m.mailbox.status}`)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.card} aria-labelledby="fallbacks">
        <h2 className={styles.h2} id="fallbacks">
          {at("mailSettings.fallbacks.title")}
        </h2>
        <p className={styles.muted} style={{ marginTop: 0 }}>
          {at("mailSettings.fallbacks.intro")}
        </p>
        {s.fallbacks.length === 0 ? (
          <p className={styles.muted}>{at("mailSettings.fallbacks.none")}</p>
        ) : (
          <ul className={styles.list}>
            {s.fallbacks.map((f, i) => (
              <li key={i}>
                <div>
                  <strong>{f.toEmail}</strong>
                  <div className={styles.hint}>{f.reason}</div>
                </div>
                <span className={styles.nowrap}>{formatDateTime(f.sentAt, tz)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
