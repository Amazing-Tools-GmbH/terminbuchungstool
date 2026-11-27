import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin, canManage } from "@/lib/auth/admin";
import { activityProblemCount } from "@/lib/admin/activity";
import { listOpenAccessRequests } from "@/lib/access-requests";
import { at } from "@/lib/texts/admin";
import { AdminNav, type NavItem } from "@/components/admin/AdminNav";
import styles from "@/components/admin/Admin.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Admin", robots: { index: false, follow: false } };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireAdmin();
  const [problems, requests] = await Promise.all([activityProblemCount(ctx), listOpenAccessRequests(ctx).catch(() => [])]);
  const items: NavItem[] = [
    { href: "/admin/uebersicht", label: at("nav.dashboard") },
    { href: "/admin", label: at("nav.slots") },
    { href: "/admin/buchungen", label: at("nav.bookings") },
    ...(canManage(ctx.role) ? [{ href: "/admin/verlauf", label: at("nav.activity") }] : []),
    { href: "/admin/email", label: at("nav.mailSettings") },
    ...(canManage(ctx.role) ? [{ href: "/admin/erscheinungsbild", label: at("nav.branding") }] : []),
    ...(canManage(ctx.role) ? [{ href: "/admin/einstellungen", label: at("nav.settings") }] : []),
    ...(canManage(ctx.role) ? [{ href: "/admin/vorlagen", label: at("nav.templates") }] : []),
    ...(canManage(ctx.role) ? [{ href: "/admin/pipedrive", label: at("nav.pipedrive") }] : []),
    ...(canManage(ctx.role) ? [{ href: "/admin/benutzer", label: at("nav.users") }] : []),
  ];

  return (
    <div className={styles.root}>
      <header className={styles.topbar}>
        <div className={styles.brand}>
          {ctx.tenant.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={ctx.tenant.logoUrl} alt="" className={styles.topbarLogo} />
          )}
          <span>
            {at("app.title")}
            <small>{ctx.tenant.name}</small>
          </span>
        </div>
        <div className={styles.userBox}>
          <span>
            {ctx.name ?? ctx.email} · {at(`role.${ctx.role}`)}
          </span>
          <form action="/api/auth/logout" method="post">
            <button type="submit" className={styles.btnGhost}>
              {at("user.logout")}
            </button>
          </form>
        </div>
      </header>
      <div className={styles.layout}>
        <AdminNav items={items} label={at("nav.label")} />
        <main className={styles.main}>
          {requests.length > 0 && (
            <div role="status" className={`${styles.info} ${styles.problemBanner}`}>
              <span>{at("users.requests.banner", { n: requests.length })}</span>
              <Link href="/admin/benutzer" className={styles.btnGhost}>
                {at("users.requests.bannerLink")}
              </Link>
            </div>
          )}
          {problems > 0 && (
            <div role="status" className={`${styles.error} ${styles.problemBanner}`}>
              <span>{at("activity.problems", { n: problems })}</span>
              <Link href="/admin/verlauf?errors=1" className={styles.btnGhost}>
                {at("activity.problemsLink")}
              </Link>
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
