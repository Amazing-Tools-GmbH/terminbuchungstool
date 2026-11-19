import { requireAdmin, type MemberRole } from "@/lib/auth/admin";
import { loadTeam, type TeamEntry } from "@/lib/admin/members";
import { isAdminErrorCode } from "@/lib/admin/errors";
import { adminErrorText, at } from "@/lib/texts/admin";
import styles from "@/components/admin/Admin.module.css";
import { enableMemberAction, updateMemberAction } from "../actions";

type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Rollenauswahl in der Spalte "Rolle"; gehört per form-Attribut zum Formular in "Aktionen" */
function RoleSelect({ form, name, roles, value }: { form: string; name: string; roles: MemberRole[]; value: MemberRole }) {
  return (
    <select form={form} name="role" defaultValue={value} className={styles.inlineSelect} aria-label={at("users.roleFor", { name })}>
      {roles.map((r) => (
        <option key={r} value={r}>
          {at(`role.${r}`)}
        </option>
      ))}
    </select>
  );
}

function Row({ e, viewerRole, idx }: { e: TeamEntry; viewerRole: MemberRole; idx: number }) {
  const roles: MemberRole[] = viewerRole === "owner" ? ["owner", "admin", "sales"] : ["admin", "sales"];
  const m = e.member;
  // admin darf owner nicht ändern; niemand ändert sich selbst
  const locked = e.isSelf || (viewerRole !== "owner" && m?.role === "owner");
  const canEnable = !m && e.pipedrive?.active;
  const state = !m ? "none" : m.status;

  return (
    <tr>
      <td>
        <strong>{e.name}</strong>
        {e.isSelf && <span className={styles.tag}>{at("users.self")}</span>}
        {e.pipedrive?.isAdmin && <span className={styles.tag}>{at("users.pdAdmin")}</span>}
        {e.pipedrive && !e.pipedrive.active && <span className={styles.tag}>{at("users.pdInactive")}</span>}
        {!e.pipedrive && <span className={styles.tag}>{at("users.pdMissing")}</span>}
      </td>
      <td data-label={at("users.email")}>{e.email}</td>
      <td data-label={at("users.access")}>
        <span className={`${styles.badge} ${styles[state === "active" ? "lvl_ok" : state === "disabled" ? "lvl_full" : "lvl_closed"]}`}>
          {at(`users.state.${state}`)}
        </span>
      </td>
      <td data-label={at("users.role")}>
        {canEnable ? (
          <RoleSelect form={`enable-${idx}`} name={e.name} roles={roles} value="sales" />
        ) : m && m.status === "active" && !locked ? (
          <RoleSelect form={`role-${idx}`} name={e.name} roles={roles} value={m.role} />
        ) : m ? (
          at(`role.${m.role}`)
        ) : (
          "—"
        )}
      </td>
      <td>
        <div className={styles.rowActions}>
          {canEnable && e.pipedrive && (
            <form id={`enable-${idx}`} action={enableMemberAction}>
              <input type="hidden" name="pipedriveUserId" value={e.pipedrive.id} />
              <button type="submit" className={styles.btn}>
                {at("users.enable")}
              </button>
            </form>
          )}
          {m && !locked && m.status === "active" && (
            <>
              <form id={`role-${idx}`} action={updateMemberAction}>
                <input type="hidden" name="userId" value={m.userId} />
                <button type="submit" className={styles.btnGhost}>
                  {at("users.saveRole")}
                </button>
              </form>
              <form action={updateMemberAction}>
                <input type="hidden" name="userId" value={m.userId} />
                <input type="hidden" name="status" value="disabled" />
                <button type="submit" className={styles.btnDanger}>
                  {at("users.disable")}
                </button>
              </form>
            </>
          )}
          {m && !locked && m.status === "disabled" && (
            <form action={updateMemberAction}>
              <input type="hidden" name="userId" value={m.userId} />
              <input type="hidden" name="status" value="active" />
              <button type="submit" className={styles.btnGhost}>
                {at("users.reenable")}
              </button>
            </form>
          )}
        </div>
      </td>
    </tr>
  );
}

export default async function UsersPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const sp = await searchParams;
  const team = await loadTeam(ctx);
  const error = one(sp.error);

  return (
    <>
      <div>
        <h1 className={styles.h1}>{at("users.title")}</h1>
        <p className={styles.muted} style={{ maxWidth: 760 }}>
          {at("users.intro")}
        </p>
      </div>

      {error && (
        <p role="alert" className={styles.error}>
          {adminErrorText(isAdminErrorCode(error) ? error : "generic")}
        </p>
      )}
      {one(sp.ok) && (
        <p role="status" className={styles.notice}>
          {at("users.saved")}
        </p>
      )}
      {team.directory !== "ok" && <p className={styles.info}>{at(`users.dir.${team.directory}`)}</p>}
      {team.source === "fake" && <p className={styles.info}>{at("users.dir.fake")}</p>}

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{at("users.name")}</th>
              <th scope="col">{at("users.email")}</th>
              <th scope="col">{at("users.access")}</th>
              <th scope="col">{at("users.role")}</th>
              <th scope="col">{at("users.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {team.entries.map((e, i) => (
              <Row key={e.member?.userId ?? `pd-${e.pipedrive?.id}`} e={e} viewerRole={ctx.role} idx={i} />
            ))}
          </tbody>
        </table>
      </div>
      <p className={styles.hint}>{at("users.roles")}</p>
    </>
  );
}
