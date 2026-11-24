import type { Metadata } from "next";
import { requireAdmin, canManage } from "@/lib/auth/admin";
import { at } from "@/lib/texts/admin";
import { AdminNav, type NavItem } from "@/components/admin/AdminNav";
import styles from "@/components/admin/Admin.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Admin", robots: { index: false, follow: false } };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireAdmin();
  const items: NavItem[] = [
    { href: "/admin", label: at("nav.slots") },
    { href: "/admin/buchungen", label: at("nav.bookings") },
    { href: "/admin/postfach", label: at("nav.mailbox") },
    ...(canManage(ctx.role) ? [{ href: "/admin/email", label: at("nav.mailSettings") }] : []),
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
        <main className={styles.main}>{children}</main>
      </div>
    </div>
  );
}
