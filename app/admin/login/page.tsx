import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { withActor } from "@/lib/db";
import { devToolsEnabled } from "@/lib/dev-tools";
import { getAdminContext } from "@/lib/auth/admin";
import { at, loginErrorText } from "@/lib/texts/admin";
import styles from "@/components/admin/Admin.module.css";
import { devLoginAction } from "./actions";
import { withBasePath } from "@/lib/base-path";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Anmelden", robots: { index: false, follow: false } };

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function LoginPage({ searchParams }: { searchParams: Search }) {
  if (await getAdminContext()) redirect("/admin");

  const sp = await searchParams;
  const error = loginErrorText(Array.isArray(sp.error) ? sp.error[0] : sp.error);
  const dev = devToolsEnabled();
  const devUsers = dev
    ? await withActor({ role: "service_role" }, async (db) => {
        const { rows } = await db.query<{
          user_id: string;
          tenant_id: string;
          tenant_name: string;
          display_name: string | null;
          email: string | null;
          role: string;
        }>(
          `select m.user_id, m.tenant_id, t.name as tenant_name, m.display_name, m.email, m.role::text as role
             from public.tenant_members m join public.tenants t on t.id = m.tenant_id
            where m.status = 'active' order by t.name, m.role, m.display_name`,
        );
        return rows;
      })
    : [];

  return (
    <div className={styles.root}>
      <main className={styles.loginWrap}>
        <div className={`${styles.card} ${styles.loginCard}`}>
          <div>
            <p className={styles.muted} style={{ margin: 0 }}>
              {at("app.title")}
            </p>
            <h1 className={styles.h1}>{at("login.title")}</h1>
          </div>
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          <p style={{ margin: 0 }}>{at("login.intro")}</p>
          <a className={`${styles.btn} ${styles.btnLarge}`} href={withBasePath("/api/auth/pipedrive/start")}>
            {at("login.pipedrive")}
          </a>

          {dev && (
            <section aria-labelledby="dev-login" style={{ borderTop: "1px solid var(--adm-line)", paddingTop: 16 }}>
              <h2 className={styles.h2} id="dev-login">
                {at("login.dev.title")}
              </h2>
              <p className={styles.hint}>{at("login.dev.hint")}</p>
              {devUsers.length === 0 ? (
                <p className={styles.muted}>{at("login.dev.none")}</p>
              ) : (
                <div className={styles.actions}>
                  {devUsers.map((u) => (
                    <form key={`${u.tenant_id}:${u.user_id}`} action={devLoginAction}>
                      <input type="hidden" name="userId" value={u.user_id} />
                      <input type="hidden" name="tenantId" value={u.tenant_id} />
                      <button type="submit" className={styles.btnGhost}>
                        {u.display_name ?? u.email} ({at(`role.${u.role as "owner" | "admin" | "sales"}`)}, {u.tenant_name})
                      </button>
                    </form>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
