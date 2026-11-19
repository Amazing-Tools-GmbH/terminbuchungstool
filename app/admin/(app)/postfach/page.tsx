import { requireAdmin } from "@/lib/auth/admin";
import { loadMyMailbox, type PipedriveSendStatus } from "@/lib/mail/connect";
import { inviteMailProvider, oauthProvidersVisible, systemMailConfig } from "@/lib/mail/config";
import { devToolsEnabled } from "@/lib/dev-tools";
import { flashMessages } from "@/lib/admin/messages";
import { at } from "@/lib/texts/admin";
import { MailboxCard } from "@/components/admin/MailboxCard";
import styles from "@/components/admin/Admin.module.css";
import { saveSignatureAction } from "./actions";

type Search = Promise<Record<string, string | string[] | undefined>>;
const LEVEL: Record<PipedriveSendStatus["state"], string> = { ready: "lvl_ok", missing_scope: "lvl_low", error: "lvl_full", none: "lvl_closed" };

function PipedriveStatus({ status }: { status: PipedriveSendStatus }) {
  const text =
    status.state === "ready"
      ? at("mailbox.pd.ready")
      : status.state === "error"
        ? at("mailbox.pd.error", { reason: status.lastError ?? "—" })
        : status.state === "missing_scope"
          ? at("mailbox.pd.missingScope")
          : at("mailbox.pd.none");
  return (
    <div className={styles.mailbox}>
      <div className={styles.mailboxStatus}>
        <strong>Pipedrive</strong>
        <span className={`${styles.badge} ${styles[LEVEL[status.state]]}`}>{at(`mailbox.state.${status.state}`)}</span>
      </div>
      <p className={status.state === "error" ? styles.error : status.state === "ready" ? undefined : styles.info} style={{ margin: 0 }}>
        {text}
      </p>
      {status.state === "ready" && <p className={styles.hint} style={{ margin: 0 }}>{at("mailbox.pd.readyHint")}</p>}
    </div>
  );
}

export default async function MyMailboxPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireAdmin();
  const { mine, pipedrive, signature } = await loadMyMailbox(ctx);
  const { ok, error } = flashMessages(await searchParams);
  const mode = inviteMailProvider();
  const providers = oauthProvidersVisible();
  const system = systemMailConfig();

  return (
    <>
      <div>
        <h1 className={styles.h1}>{at("mailbox.title")}</h1>
        <p className={styles.muted} style={{ maxWidth: 760 }}>
          {mode === "smtp" ? at("mailbox.intro.smtp", { email: system?.fromEmail ?? "—" }) : at(`mailbox.intro.${mode}`)}
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

      {mode !== "smtp" && (
        <section className={styles.card} aria-labelledby="send-title">
          <h2 className={styles.h2} id="send-title">
            {at("mailbox.send.title")}
          </h2>
          {mode === "pipedrive" ? (
            <PipedriveStatus status={pipedrive} />
          ) : providers.google || providers.microsoft || mine || devToolsEnabled() ? (
            <MailboxCard scope="user" mailbox={mine} providers={providers} dev={devToolsEnabled()} timezone={ctx.tenant.timezone} />
          ) : (
            <p className={styles.info}>{at("mailbox.oauthMissing")}</p>
          )}
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

      <p className={system ? styles.info : styles.error}>
        {system ? at("mailbox.confirmInfo", { email: system.fromEmail }) : at("mailbox.confirmInfoMissing")}
      </p>
    </>
  );
}
