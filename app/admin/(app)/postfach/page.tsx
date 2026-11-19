import { requireAdmin } from "@/lib/auth/admin";
import { loadMyMailbox } from "@/lib/mail/connect";
import { mailOAuthConfig } from "@/lib/mail/oauth";
import { devToolsEnabled } from "@/lib/dev-tools";
import { flashMessages } from "@/lib/admin/messages";
import { at } from "@/lib/texts/admin";
import { MailboxCard } from "@/components/admin/MailboxCard";
import styles from "@/components/admin/Admin.module.css";

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function MyMailboxPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireAdmin();
  const { mine, tenantMailbox } = await loadMyMailbox(ctx);
  const { ok, error } = flashMessages(await searchParams);
  const providers = { google: Boolean(mailOAuthConfig("google")), microsoft: Boolean(mailOAuthConfig("microsoft")) };

  return (
    <>
      <div>
        <h1 className={styles.h1}>{at("mailbox.title")}</h1>
        <p className={styles.muted} style={{ maxWidth: 760 }}>
          {at("mailbox.intro")}
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
      <section className={styles.card} aria-label={at("mailbox.title")}>
        <MailboxCard scope="user" mailbox={mine} providers={providers} dev={devToolsEnabled()} timezone={ctx.tenant.timezone} />
      </section>
      {mine?.status !== "active" && (
        <p className={styles.info}>
          {tenantMailbox?.status === "active" ? at("mailbox.fallbackInfo", { email: tenantMailbox.sender_email }) : at("mailbox.noTenantMailbox")}
        </p>
      )}
    </>
  );
}
