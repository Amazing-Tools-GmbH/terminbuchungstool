import type { ReactNode } from "react";
import type { PublicTenant } from "@/lib/tenant/types";
import styles from "./TenantHeader.module.css";

/** Header mit Logo (oder Mandantenname als Text) und Claim */
export function TenantHeader({ tenant, aside }: { tenant: PublicTenant; aside?: ReactNode }) {
  return (
    <>
      <header className={styles.header}>
        <div className={`tb-container ${styles.inner}`}>
          <div className={styles.brand}>
            {tenant.logoUrl ? (
              <img className={styles.logo} src={tenant.logoUrl} alt={tenant.name} />
            ) : (
              <span className={styles.textBrand}>{tenant.name}</span>
            )}
            {tenant.claim && <span className={styles.claim}>{tenant.claim}</span>}
          </div>
          {aside && <div className={styles.aside}>{aside}</div>}
        </div>
      </header>
      <div className={styles.strip} aria-hidden="true" />
    </>
  );
}
