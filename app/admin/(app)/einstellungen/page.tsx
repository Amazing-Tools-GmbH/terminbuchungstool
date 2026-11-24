import { requireAdmin } from "@/lib/auth/admin";
import { flashMessages } from "@/lib/admin/messages";
import { LEGAL_LINK_ROWS, loadSettings, missingLegal } from "@/lib/admin/settings";
import { at } from "@/lib/texts/admin";
import styles from "@/components/admin/Admin.module.css";
import { saveSettingsAction } from "./actions";

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function SettingsPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const { ok, error } = flashMessages(await searchParams);
  const s = await loadSettings(ctx);
  const missing = missingLegal(s.legalLinks);
  const rows = Array.from({ length: LEGAL_LINK_ROWS }, (_, i) => s.legalLinks[i] ?? { label: "", href: "" });
  // leeres Formular: übliche Bezeichnungen vorschlagen
  if (s.legalLinks.length === 0) {
    rows[0]!.label = "Impressum";
    rows[1]!.label = "Datenschutz";
  }

  return (
    <>
      <h1 className={styles.h1}>{at("settings.title")}</h1>
      <p className={styles.muted} style={{ margin: 0 }}>
        {at("settings.intro")}
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
      {missing.length > 0 && (
        <p role="status" className={styles.info}>
          {at("settings.missing", { list: missing.map((m) => at(`settings.missing.${m}`)).join(", ") })}
        </p>
      )}

      <form action={saveSettingsAction} className={styles.brandingFields}>
        <section className={styles.card} aria-labelledby="set-company">
          <h2 className={styles.h2} id="set-company">
            {at("settings.company")}
          </h2>
          <div className={styles.form}>
            <div className={`${styles.field} ${styles.full}`}>
              <label htmlFor="set-name">{at("settings.name")}</label>
              <input id="set-name" name="name" required maxLength={200} defaultValue={s.name} aria-describedby="set-name-hint" />
              <span id="set-name-hint" className={styles.hint}>
                {at("settings.nameHint")}
              </span>
            </div>
            <div className={styles.field}>
              <label htmlFor="set-sender">{at("settings.senderName")}</label>
              <input id="set-sender" name="senderName" maxLength={200} defaultValue={s.senderName ?? ""} placeholder={s.name} aria-describedby="set-sender-hint" />
              <span id="set-sender-hint" className={styles.hint}>
                {at("settings.senderNameHint")}
              </span>
            </div>
            <div className={styles.field}>
              <label htmlFor="set-reply">{at("settings.replyTo")}</label>
              <input id="set-reply" name="replyTo" type="email" maxLength={320} defaultValue={s.replyTo ?? ""} aria-describedby="set-reply-hint" />
              <span id="set-reply-hint" className={styles.hint}>
                {at("settings.replyToHint")}
              </span>
            </div>
            <fieldset className={`${styles.full} ${styles.fieldset}`} aria-describedby="set-anrede-hint">
              <legend>{at("settings.anrede")}</legend>
              <div className={styles.actions}>
                {(["sie", "ihr"] as const).map((a) => (
                  <label key={a} className={styles.check}>
                    <input type="radio" name="anrede" value={a} defaultChecked={s.anrede === a} required /> {at(`settings.anrede.${a}`)}
                  </label>
                ))}
              </div>
              <span id="set-anrede-hint" className={styles.hint}>
                {at("settings.anredeHint")}
              </span>
            </fieldset>
          </div>
        </section>

        <section className={styles.card} aria-labelledby="set-booking">
          <h2 className={styles.h2} id="set-booking">
            {at("settings.booking")}
          </h2>
          <div className={styles.field}>
            <label htmlFor="set-deadline">{at("settings.deadline")}</label>
            <input
              id="set-deadline"
              name="changeDeadlineHours"
              type="number"
              min={0}
              max={720}
              required
              defaultValue={s.changeDeadlineHours}
              style={{ maxWidth: 140 }}
              aria-describedby="set-deadline-hint"
            />
            <span id="set-deadline-hint" className={styles.hint}>
              {at("settings.deadlineHint")}
            </span>
          </div>
        </section>

        <section className={styles.card} aria-labelledby="set-legal">
          <h2 className={styles.h2} id="set-legal">
            {at("settings.legal")}
          </h2>
          <div className={styles.form}>
            <div className={`${styles.field} ${styles.full}`}>
              <label htmlFor="set-contact">{at("settings.contactLine")}</label>
              <input id="set-contact" name="contactLine" maxLength={200} defaultValue={s.contactLine ?? ""} aria-describedby="set-contact-hint" />
              <span id="set-contact-hint" className={styles.hint}>
                {at("settings.contactLineHint")}
              </span>
            </div>
            <fieldset className={`${styles.full} ${styles.fieldset}`} aria-describedby="set-legal-hint">
              <legend>{at("settings.legalLinks")}</legend>
              <span id="set-legal-hint" className={styles.hint}>
                {at("settings.legalLinksHint")}
              </span>
              {rows.map((l, i) => (
                <div key={i} className={styles.form} style={{ marginTop: 8 }}>
                  <div className={styles.field}>
                    <label htmlFor={`set-ll-${i}`}>{at("settings.legalLabel", { n: i + 1 })}</label>
                    <input id={`set-ll-${i}`} name={`legalLabel${i}`} maxLength={60} defaultValue={l.label} />
                  </div>
                  <div className={styles.field}>
                    <label htmlFor={`set-lh-${i}`}>{at("settings.legalHref", { n: i + 1 })}</label>
                    <input id={`set-lh-${i}`} name={`legalHref${i}`} type="url" maxLength={500} placeholder="https://" defaultValue={l.href} />
                  </div>
                </div>
              ))}
            </fieldset>
          </div>
        </section>

        <div>
          <button type="submit" className={`${styles.btn} ${styles.btnLarge}`}>
            {at("settings.save")}
          </button>
        </div>
      </form>
    </>
  );
}
