import { requireAdmin } from "@/lib/auth/admin";
import { flashMessages } from "@/lib/admin/messages";
import { loadConnectionStatus } from "@/lib/pipedrive/manage";
import { formatDateTime } from "@/lib/datetime";
import { at } from "@/lib/texts/admin";
import styles from "@/components/admin/Admin.module.css";
import { disconnectPipedriveAction, testPipedriveAction } from "./actions";

type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const LEVEL = { active: "lvl_ok", revoked: "lvl_full", none: "lvl_closed" } as const;

export default async function PipedrivePage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const sp = await searchParams;
  const { ok, error } = flashMessages(sp);
  const s = await loadConnectionStatus(ctx);
  const tz = ctx.tenant.timezone;
  const owner = ctx.role === "owner";
  const testOk = one(sp.test) === "ok" ? at("pd.testOk", { company: one(sp.company) || s.companyDomain || "—", user: one(sp.user) ?? "—" }) : null;

  return (
    <>
      <h1 className={styles.h1}>{at("pd.title")}</h1>
      <p className={styles.muted} style={{ margin: 0 }}>
        {at("pd.intro")}
      </p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {(ok || testOk) && (
        <p role="status" className={styles.notice}>
          {ok ?? testOk}
        </p>
      )}

      <section className={styles.card} aria-labelledby="pd-status">
        <div className={styles.headRow}>
          <h2 className={styles.h2} id="pd-status" style={{ margin: 0 }}>
            {s.companyUrl ? (
              <a href={s.companyUrl} target="_blank" rel="noopener noreferrer">
                {s.companyDomain}.pipedrive.com
              </a>
            ) : (
              (s.companyDomain ?? at("pd.status.none"))
            )}
          </h2>
          <span className={`${styles.badge} ${styles[LEVEL[s.status]]}`}>{at(`pd.status.${s.status}`)}</span>
        </div>
        <ul className={styles.list} style={{ marginTop: 12 }}>
          <li>
            <strong>{at("pd.companyId")}</strong>
            <span>{s.companyId ?? "—"}</span>
          </li>
          <li>
            <strong>{at("pd.connectedAt")}</strong>
            <span>{s.connectedAt ? formatDateTime(s.connectedAt, tz) : "—"}</span>
          </li>
          {s.status === "revoked" && (
            <li>
              <strong>{at("pd.revokedAt")}</strong>
              <span>{s.revokedAt ? formatDateTime(s.revokedAt, tz) : "—"}</span>
            </li>
          )}
          <li>
            <strong>{at("pd.installedBy")}</strong>
            <span>{s.installedBy ?? "—"}</span>
          </li>
          <li>
            <strong>{at("pd.jobs")}</strong>
            <span>{at("pd.jobsValue", { queued: s.jobs.queued, failed: s.jobs.failed })}</span>
          </li>
          <li>
            <strong>{at("pd.team")}</strong>
            <span>{at("pd.teamValue", { active: s.team.active, error: s.team.withError })}</span>
          </li>
          {s.scopes.length > 0 && (
            <li>
              <strong>{at("pd.scopes")}</strong>
              <span className={styles.hint}>{s.scopes.join(", ")}</span>
            </li>
          )}
        </ul>
        {s.jobs.lastError && s.jobs.lastErrorAt && (
          <p className={styles.hint}>{at("pd.lastError", { at: formatDateTime(s.jobs.lastErrorAt, tz), error: s.jobs.lastError.slice(0, 200) })}</p>
        )}
        {s.status === "active" && (
          <form action={testPipedriveAction} style={{ marginTop: 12 }}>
            <button type="submit" className={styles.btnGhost}>
              {at("pd.test")}
            </button>
          </form>
        )}
      </section>

      <section className={styles.card} aria-labelledby="pd-connect">
        <h2 className={styles.h2} id="pd-connect">
          {s.status === "none" ? at("pd.connect.title") : at("pd.connect.titleActive")}
        </h2>
        <p style={{ marginTop: 0 }}>{at("pd.connect.text")}</p>
        {s.status !== "none" && <p className={styles.info}>{at("pd.connect.changeWarn")}</p>}
        {owner ? (
          <a className={styles.btn} href="/api/auth/pipedrive/relink" style={{ display: "inline-flex", marginTop: 12 }}>
            {at("pd.connect.button")}
          </a>
        ) : (
          <p className={styles.hint}>{at("pd.connect.ownerOnly")}</p>
        )}
      </section>

      {owner && s.status === "active" && (
        <section className={styles.card} aria-labelledby="pd-disconnect">
          <h2 className={styles.h2} id="pd-disconnect">
            {at("pd.disconnect.title")}
          </h2>
          <p style={{ marginTop: 0 }}>{at("pd.disconnect.text")}</p>
          <form action={disconnectPipedriveAction} className={styles.brandingFields}>
            <label className={styles.check}>
              <input type="checkbox" name="confirm" value="yes" required />
              {at("pd.disconnect.confirm")}
            </label>
            <div>
              <button type="submit" className={styles.btnDanger}>
                {at("pd.disconnect.button")}
              </button>
            </div>
          </form>
        </section>
      )}
    </>
  );
}
