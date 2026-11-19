import { getCurrentTenant } from "@/lib/tenant/current";
import { createTranslator } from "@/lib/texts";
import { TenantHeader } from "@/components/tenant/TenantHeader";
import { TenantFooter } from "@/components/tenant/TenantFooter";
import styles from "./page.module.css";

export default async function HomePage() {
  const tenant = await getCurrentTenant();

  if (!tenant) {
    return (
      <main className={`tb-container ${styles.neutral}`}>
        <h1>Terminbuchung</h1>
        <p>Für diese Adresse ist keine Buchungsseite eingerichtet.</p>
      </main>
    );
  }

  const t = createTranslator(tenant.anrede, tenant.textOverrides);
  return (
    <>
      <TenantHeader tenant={tenant} />
      <main>
        <section className={styles.hero}>
          <div className="tb-container">
            <h1>{t("page.title")}</h1>
            <p>{t("home.useLink")}</p>
          </div>
        </section>
      </main>
      <TenantFooter tenant={tenant} t={t} />
    </>
  );
}
