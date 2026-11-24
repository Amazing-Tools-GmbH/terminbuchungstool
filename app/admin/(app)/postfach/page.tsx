import { requireAdmin } from "@/lib/auth/admin";
import { loadMyMailbox } from "@/lib/mail/connect";
import { oauthProvidersVisible, systemMailConfig } from "@/lib/mail/config";
import { devToolsEnabled } from "@/lib/dev-tools";
import { flashMessages } from "@/lib/admin/messages";
import { at } from "@/lib/texts/admin";
import { MailboxCard } from "@/components/admin/MailboxCard";
import styles from "@/components/admin/Admin.module.css";
import { saveSignatureAction } from "./actions";

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function MyMailboxPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireAdmin();
  const { mine, mailRoute, signature } = await loadMyMailbox(ctx);
  const { ok, error } = flashMessages(await searchParams);
  const providers = oauthProvidersVisible();
  const system = systemMailConfig();
  const employee = mailRoute === "employee";

  return (
    <>
      <div>
        <h1 className={styles.h1}>{at("mailbox.title")}</h1>
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

      {(employee || mine) && (
        <section className={styles.card} aria-labelledby="send-title">
          <h2 className={styles.h2} id="send-title">
            {at("mailbox.send.title")}
          </h2>
          {!employee && <p className={styles.info}>{at("mailbox.employee.inactive")}</p>}
          <MailboxCard scope="user" mailbox={mine} providers={providers} dev={devToolsEnabled()} timezone={ctx.tenant.timezone} showSmtp />
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

      {!employee && (
        <p className={system ? styles.info : styles.error}>
          {system ? at("mailbox.confirmInfo", { email: system.fromEmail }) : at("mailbox.confirmInfoMissing")}
        </p>
      )}
    </>
  );
}
