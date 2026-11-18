import Link from "next/link";
import { notFound } from "next/navigation";
import { withActor } from "@/lib/db";
import { devToolsEnabled } from "@/lib/dev-tools";
import styles from "./mails.module.css";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  type: string;
  to_email: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  sent_at: Date | null;
  subject: string | null;
  tenant: string;
};

/** Alle Mails der Outbox (Entwicklung). Mit dev-Postfach versendete Mails sind hier lesbar. */
export default async function DevMailsPage() {
  if (!devToolsEnabled()) notFound();
  const rows = await withActor({ role: "service_role" }, async (c) => {
    const { rows } = await c.query<Row>(
      `select o.id, o.type, o.to_email, o.status, o.attempts, o.last_error, o.created_at, o.sent_at,
              o.rendered->>'subject' as subject, t.slug as tenant
         from public.email_outbox o join public.tenants t on t.id = o.tenant_id
        order by o.created_at desc limit 200`,
    );
    return rows;
  });

  return (
    <main className={styles.page}>
      <h1>Outbox (Entwicklung)</h1>
      <p>Mails über das dev-Postfach werden nicht verschickt, sondern hier angezeigt. Verarbeitung: <code>GET /api/cron/outbox</code>.</p>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Erstellt</th>
            <th>Mandant</th>
            <th>Typ</th>
            <th>An</th>
            <th>Betreff</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.created_at).toLocaleString("de-AT", { timeZone: "Europe/Vienna" })}</td>
              <td>{r.tenant}</td>
              <td>{r.type}</td>
              <td>{r.to_email}</td>
              <td>{r.subject ? <Link href={`/dev/mails/${r.id}`}>{r.subject}</Link> : "–"}</td>
              <td>
                {r.status}
                {r.attempts > 0 ? ` (${r.attempts})` : ""}
                {r.last_error ? <div className={styles.error}>{r.last_error}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
