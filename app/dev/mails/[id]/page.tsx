import Link from "next/link";
import { notFound } from "next/navigation";
import { withActor } from "@/lib/db";
import { devToolsEnabled } from "@/lib/dev-tools";
import type { MailMessage } from "@/lib/mail/types";
import styles from "../mails.module.css";

export const dynamic = "force-dynamic";

export default async function DevMailPage({ params }: { params: Promise<{ id: string }> }) {
  if (!devToolsEnabled()) notFound();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const mail = await withActor({ role: "service_role" }, async (c) => {
    const { rows } = await c.query<{ rendered: MailMessage | null }>("select rendered from public.email_outbox where id = $1", [id]);
    return rows[0]?.rendered ?? null;
  });
  if (!mail) notFound();

  return (
    <main className={styles.page}>
      <p>
        <Link href="/dev/mails">← Outbox</Link>
      </p>
      <dl className={styles.meta}>
        <dt>Von</dt>
        <dd>
          {mail.from.name} &lt;{mail.from.email}&gt;
        </dd>
        <dt>An</dt>
        <dd>
          {mail.to.name} &lt;{mail.to.email}&gt;
        </dd>
        {mail.replyTo && (
          <>
            <dt>Antwort an</dt>
            <dd>{mail.replyTo.email}</dd>
          </>
        )}
        <dt>Betreff</dt>
        <dd>{mail.subject}</dd>
        {mail.attachments?.map((a, i) => (
          <div key={a.filename} className={styles.pair}>
            <dt>Anhang</dt>
            <dd>
              <a href={`/dev/mails/${id}/ics?i=${i}`}>{a.filename}</a>
            </dd>
          </div>
        ))}
      </dl>
      {/* sandbox ohne Skripte: gerenderte HTML-Mail sicher anzeigen */}
      <iframe className={styles.frame} title={mail.subject} sandbox="" srcDoc={mail.html} />
      <details>
        <summary>Textversion</summary>
        <pre className={styles.text}>{mail.text}</pre>
      </details>
    </main>
  );
}
