import type { Metadata } from "next";
import { requireAdmin, canManage } from "@/lib/auth/admin";
import { at } from "@/lib/texts/admin";
import { AdminNav, type NavItem } from "@/components/admin/AdminNav";
import styles from "@/components/admin/Admin.module.css";
import { withBasePath } from "@/lib/base-path";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Admin", robots: { index: false, follow: false } };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireAdmin();
  const soon = at("nav.soon");
  const items: NavItem[] = [
    { href: "/admin", label: at("nav.slots") },
    { href: null, label: at("nav.bookings"), soon },
    { href: null, label: at("nav.events"), soon },
    { href: "/admin/postfach", label: at("nav.mailbox") },
    ...(canManage(ctx.role) ? [{ href: "/admin/email", label: at("nav.mailSettings") }] : []),
    { href: null, label: at("nav.templates"), soon },
    { href: null, label: at("nav.pipedrive"), soon },
    ...(canManage(ctx.role) ? [{ href: "/admin/benutzer", label: at("nav.users") }] : []),
  ];

  return (
    <div className={styles.root}>
      <header className={styles.topbar}>
        <div className={styles.brand}>
          {at("app.title")}
          <small>{ctx.tenant.name}</small>
        </div>
        <div className={styles.userBox}>
          <span>
            {ctx.name ?? ctx.email} · {at(`role.${ctx.role}`)}
          </span>
          <form action={withBasePath("/api/auth/logout")} method="post">
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
