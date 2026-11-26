"use client";
/**
 * App-Einstellungen in Pipedrive (eingebettet): Zugriffsanfragen und
 * Nutzerverwaltung wie im Admin; alle übrigen Einstellungen im Admin (neuer Tab).
 * Aufrufe an /api/app-settings mit der Sitzung als Bearer (kein Cookie im iframe).
 */
import { useCallback, useRef, useState } from "react";
import type { Team, TeamEntry } from "@/lib/admin/team";
import type { MemberRole } from "@/lib/auth/roles";
import { formatText } from "@/lib/texts";
import { usePipedriveSdk } from "@/components/panel/usePipedriveSdk";
import styles from "@/components/admin/Admin.module.css";

type Request = { id: string; pipedriveUserId: number; name: string | null; email: string | null; createdAt: string | Date };
type Snapshot = { team: Team; requests: Request[]; viewer: { role: MemberRole } };

export function AppSettings(props: { bearer: string; theme: "light" | "dark"; texts: Record<string, string>; tenantName: string; initial: Snapshot }) {
  const t = useCallback((k: string, v?: Record<string, string | number>) => formatText(props.texts[k] ?? k, v), [props.texts]);
  const rootRef = useRef<HTMLDivElement>(null);
  usePipedriveSdk(rootRef);
  const [tab, setTab] = useState<"users" | "more">("users");
  const [data, setData] = useState(props.initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [roles, setRoles] = useState<Record<string, MemberRole>>({});

  const viewer = data.viewer.role;
  const roleOptions: MemberRole[] = viewer === "owner" ? ["owner", "admin", "sales"] : ["admin", "sales"];

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/app-settings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${props.bearer}` },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string } & Partial<Snapshot>;
      if (res.status === 401) return setError(t("appSettings.session"));
      if (!json.ok) return setError(json.message ?? t("users.saved"));
      setData({ team: json.team!, requests: json.requests!, viewer: json.viewer! });
      setNotice(t("appSettings.saved"));
    } catch {
      setError(t("appSettings.session"));
    } finally {
      setBusy(false);
    }
  }

  const roleFor = (key: string, fallback: MemberRole) => roles[key] ?? fallback;
  const RoleSelect = ({ id, value, label, pdAdmin = false }: { id: string; value: MemberRole; label: string; pdAdmin?: boolean }) => (
    <select className={styles.inlineSelect} value={roleFor(id, value)} aria-label={label} onChange={(e) => setRoles((r) => ({ ...r, [id]: e.target.value as MemberRole }))}>
      {roleOptions.filter((r) => !(pdAdmin && r === "sales")).map((r) => (
        <option key={r} value={r}>
          {t(`role.${r}`)}
        </option>
      ))}
    </select>
  );

  const row = (e: TeamEntry, i: number) => {
    const m = e.member;
    const locked = e.isSelf || (viewer !== "owner" && m?.role === "owner");
    const canEnable = !m && e.pipedrive?.active;
    const state = !m ? "none" : m.status;
    const key = m?.userId ?? `pd-${e.pipedrive?.id ?? i}`;
    const requested = !m && data.requests.some((r) => r.pipedriveUserId === e.pipedrive?.id);
    return (
      <tr key={key}>
        <td>
          <strong>{e.name}</strong>
          {e.isSelf && <span className={styles.tag}>{t("users.self")}</span>}
          {e.pipedrive?.isAdmin && <span className={styles.tag}>{t("users.pdAdmin")}</span>}
          {!e.pipedrive && <span className={styles.tag}>{t("users.pdMissing")}</span>}
          {requested && <span className={`${styles.badge} ${styles.lvl_low}`}>{t("users.requested")}</span>}
          <div className={styles.hint}>{e.email}</div>
        </td>
        <td data-label={t("users.access")}>
          <span className={`${styles.badge} ${styles[state === "active" ? "lvl_ok" : state === "disabled" ? "lvl_full" : "lvl_closed"]}`}>
            {t(`users.state.${state}`)}
          </span>
        </td>
        <td data-label={t("users.role")}>
          {canEnable ? (
            <RoleSelect id={key} value={e.pipedrive?.isAdmin ? "admin" : "sales"} label={t("users.roleFor", { name: e.name })} pdAdmin={e.pipedrive?.isAdmin} />
          ) : m && m.status === "active" && !locked ? (
            <RoleSelect id={key} value={m.role} label={t("users.roleFor", { name: e.name })} pdAdmin={e.pipedrive?.isAdmin} />
          ) : m ? (
            t(`role.${m.role}`)
          ) : (
            "—"
          )}
        </td>
        <td>
          <div className={styles.rowActions}>
            {canEnable && e.pipedrive && (
              <button
                type="button"
                className={styles.btn}
                disabled={busy}
                onClick={() => act({ action: "enable", pipedriveUserId: e.pipedrive!.id, role: roleFor(key, e.pipedrive!.isAdmin ? "admin" : "sales") })}
              >
                {t("users.enable")}
              </button>
            )}
            {m && !locked && m.status === "active" && (
              <>
                <button type="button" className={styles.btnGhost} disabled={busy} onClick={() => act({ action: "update", userId: m.userId, role: roleFor(key, m.role) })}>
                  {t("users.saveRole")}
                </button>
                <button type="button" className={styles.btnDanger} disabled={busy} onClick={() => act({ action: "update", userId: m.userId, status: "disabled" })}>
                  {t("users.disable")}
                </button>
              </>
            )}
            {m && !locked && m.status === "disabled" && (
              <button type="button" className={styles.btnGhost} disabled={busy} onClick={() => act({ action: "update", userId: m.userId, status: "active" })}>
                {t("users.reenable")}
              </button>
            )}
          </div>
        </td>
      </tr>
    );
  };

  return (
    <div ref={rootRef} className={styles.root} style={{ minHeight: "auto" }} data-theme={props.theme}>
      <div className={styles.main} style={{ padding: 16, maxWidth: 1100 }}>
        <div className={styles.headRow}>
          <h1 className={styles.h1} style={{ margin: 0 }}>
            {t("appSettings.title")} <small className={styles.muted}>{props.tenantName}</small>
          </h1>
        </div>
        <nav className={styles.tabs} aria-label={t("appSettings.title")}>
          {(["users", "more"] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={styles.tab}
              aria-current={tab === k ? "page" : undefined}
              onClick={() => setTab(k)}
              style={{ border: 0, cursor: "pointer", font: "inherit", fontWeight: 600 }}
            >
              {t(`appSettings.tab.${k}`)}
              {k === "users" && data.requests.length > 0 ? ` (${data.requests.length})` : ""}
            </button>
          ))}
        </nav>

        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className={styles.notice}>
            {notice}
          </p>
        )}

        {tab === "users" ? (
          <>
            {data.requests.length > 0 && (
              <section className={styles.card} aria-labelledby="as-requests">
                <h2 className={styles.h2} id="as-requests">
                  {t("users.requests.title")}
                </h2>
                <p className={styles.muted} style={{ marginTop: 0 }}>
                  {t("users.requests.intro")}
                </p>
                <ul className={`${styles.list} ${styles.bookingList}`}>
                  {data.requests.map((r) => {
                    const key = `req-${r.pipedriveUserId}`;
                    return (
                      <li key={r.id}>
                        <div>
                          <strong>{r.name ?? `Pipedrive-Benutzer ${r.pipedriveUserId}`}</strong>
                          {r.email && <div className={styles.hint}>{r.email}</div>}
                        </div>
                        <div className={styles.rowActions}>
                          <RoleSelect id={key} value="sales" label={t("users.roleFor", { name: r.name ?? String(r.pipedriveUserId) })} />
                          <button
                            type="button"
                            className={styles.btn}
                            disabled={busy}
                            onClick={() => act({ action: "enable", pipedriveUserId: r.pipedriveUserId, role: roleFor(key, "sales") })}
                          >
                            {t("users.enable")}
                          </button>
                          <button type="button" className={styles.btnGhost} disabled={busy} onClick={() => act({ action: "decline", pipedriveUserId: r.pipedriveUserId })}>
                            {t("users.requests.decline")}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {data.team.directory !== "ok" && <p className={styles.info}>{t(`users.dir.${data.team.directory}`)}</p>}
            <div className={styles.tableCard}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">{t("users.name")}</th>
                    <th scope="col">{t("users.access")}</th>
                    <th scope="col">{t("users.role")}</th>
                    <th scope="col">{t("users.actions")}</th>
                  </tr>
                </thead>
                <tbody>{data.team.entries.map(row)}</tbody>
              </table>
            </div>
            <p className={styles.hint}>{t("users.roles")}</p>
            <p className={styles.hint}>{t("users.pdAdminHint")}</p>
          </>
        ) : (
          <section className={styles.card}>
            <p style={{ marginTop: 0 }}>{t("appSettings.more.text")}</p>
            <a className={`${styles.btn} ${styles.btnLarge}`} href="/admin" target="_blank" rel="noopener" style={{ display: "inline-flex" }}>
              {t("appSettings.more.button")}
            </a>
          </section>
        )}
      </div>
    </div>
  );
}
