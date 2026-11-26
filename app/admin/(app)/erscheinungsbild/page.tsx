import { requireAdmin } from "@/lib/auth/admin";
import { flashMessages } from "@/lib/admin/messages";
import { BRANDING_COLORS, type BrandingColorKey } from "@/lib/admin/branding-logic";
import { LOGO_MAX_BYTES } from "@/lib/admin/branding";
import { createTranslator } from "@/lib/texts";
import { ADMIN_TEXTS, at } from "@/lib/texts/admin";
import { BrandingEditor } from "@/components/admin/BrandingEditor";
import styles from "@/components/admin/Admin.module.css";
import { removeLogoAction, saveBrandingAction, uploadLogoAction } from "./actions";

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function BrandingPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const { ok, error } = flashMessages(await searchParams);
  const tenant = ctx.tenant;
  const tb = createTranslator(tenant.anrede, tenant.textOverrides);
  const texts = Object.fromEntries(Object.entries(ADMIN_TEXTS).filter(([k]) => k.startsWith("branding.")));

  return (
    <>
      <h1 className={styles.h1}>{at("branding.title")}</h1>
      <p className={styles.muted} style={{ margin: 0 }}>
        {at("branding.intro")}
      </p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {ok && (
        <p role="status" className={styles.notice}>
          {ok}
        </p>
      )}

      <section className={styles.card} aria-labelledby="branding-logo">
        <h2 className={styles.h2} id="branding-logo">
          {at("branding.logo.title")}
        </h2>
        <div className={styles.logoBox}>
          <div className={styles.logoPreview} style={{ background: tenant.theme.headerBg }}>
            {tenant.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={tenant.logoUrl} alt={at("branding.logo.current")} />
            ) : (
              <span style={{ color: tenant.theme.headerInk, fontWeight: 700 }}>{tenant.name}</span>
            )}
          </div>
          {!tenant.logoUrl && <p className={styles.hint}>{at("branding.logo.none")}</p>}
        </div>
        <form action={uploadLogoAction} className={styles.form} style={{ marginTop: 16 }}>
          <div className={`${styles.field} ${styles.full}`}>
            <label htmlFor="branding-logo-file">{at("branding.logo.label")}</label>
            <input
              id="branding-logo-file"
              name="logo"
              type="file"
              required
              accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg"
              data-max-bytes={LOGO_MAX_BYTES}
              aria-describedby="branding-logo-hint"
            />
            <span id="branding-logo-hint" className={styles.hint}>
              {at("branding.logo.hint")}
            </span>
          </div>
          <div className={`${styles.actions} ${styles.full}`}>
            <button type="submit" className={styles.btn}>
              {at("branding.logo.upload")}
            </button>
            {tenant.logoUrl && (
              <button type="submit" formAction={removeLogoAction} formNoValidate className={styles.btnDanger}>
                {at("branding.logo.remove")}
              </button>
            )}
          </div>
        </form>
      </section>

      <section className={styles.card} aria-labelledby="branding-design">
        <h2 className={styles.h2} id="branding-design">
          {at("branding.design.title")}
        </h2>
        <BrandingEditor
          action={saveBrandingAction}
          texts={texts}
          preview={{
            name: tenant.name,
            logoUrl: tenant.logoUrl,
            heroIntro: tb("hero.intro"),
            submit: tb("aside.submit"),
            change: tb("done.google"),
            slotsTitle: tb("slots.title"),
          }}
          initial={{
            claim: tenant.claim ?? "",
            fontBody: tenant.theme.fontBody,
            fontDisplay: tenant.theme.fontDisplay,
            colors: Object.fromEntries(BRANDING_COLORS.map((c) => [c.key, tenant.theme[c.key]])) as Record<BrandingColorKey, string>,
          }}
        />
      </section>
    </>
  );
}
