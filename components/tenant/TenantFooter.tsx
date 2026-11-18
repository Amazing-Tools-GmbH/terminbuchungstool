import type { PublicTenant } from "@/lib/tenant/types";
import type { Translator } from "@/lib/texts";
import styles from "./TenantFooter.module.css";

export function TenantFooter({ tenant, t }: { tenant: PublicTenant; t: Translator }) {
  const year = new Intl.DateTimeFormat("de-AT", { year: "numeric", timeZone: tenant.timezone }).format(new Date());
  return (
    <footer className={styles.footer}>
      <div className={`tb-container ${styles.inner}`}>
        <span>{tenant.contactLine}</span>
        <nav aria-label={t("footer.legal")} className={styles.nav}>
          {tenant.legalLinks.map((l) => (
            <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer">
              {l.label}
            </a>
          ))}
          <span>
            © {year} {tenant.name}
          </span>
        </nav>
      </div>
    </footer>
  );
}
