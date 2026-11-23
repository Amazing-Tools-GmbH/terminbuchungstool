"use client";
/**
 * E-Mail-Vorlagen bearbeiten: Texte je Mail, erlaubte Platzhalter, Prüfung
 * und Live-Vorschau mit den echten Mail-Vorlagen (lib/mail/templates.ts).
 */
import { useMemo, useState } from "react";
import { MAIL_TEMPLATE_GROUPS, allowedPlaceholders, checkTemplate, type TemplateIssue } from "@/lib/admin/mail-templates";
import {
  renderCancellation,
  renderConfirmation,
  renderGuestCancellation,
  renderGuestConfirmation,
  renderInvitation,
  type MailTenant,
  type RenderedMail,
} from "@/lib/mail/templates";
import { formatText, type TextKey, type TextOverrides } from "@/lib/texts";
import styles from "./Admin.module.css";

type Props = {
  action: (form: FormData) => void | Promise<void>;
  texts: Record<string, string>;
  initialGroup: string;
  defaults: Record<string, string>;
  values: Record<string, string>;
  tenant: MailTenant;
  /** Beispieldaten; Zeiten als ISO-String vom Server (gleiche Darstellung auf Server und im Browser) */
  sample: { eventTitle: string; location: string | null; senderName: string; bookingUrl: string; startsAt: string; endsAt: string };
};

export function MailTemplatesEditor(props: Props) {
  const t = (k: string, v?: Record<string, string | number>) => formatText(props.texts[k] ?? k, v);
  const [group, setGroup] = useState(props.initialGroup);
  const [values, setValues] = useState(props.values);
  const current = MAIL_TEMPLATE_GROUPS.find((g) => g.id === group) ?? MAIL_TEMPLATE_GROUPS[0]!;

  const issues = useMemo(() => {
    const all: TemplateIssue[] = [];
    for (const [k, v] of Object.entries(values)) if (v.trim()) all.push(...checkTemplate(k as TextKey, v.trim()));
    return all;
  }, [values]);

  const mail = useMemo<RenderedMail>(() => {
    const overrides: TextOverrides = { ...props.tenant.textOverrides };
    for (const [k, v] of Object.entries(values)) {
      const key = k as TextKey;
      if (v.trim() && !checkTemplate(key, v.trim()).length) overrides[key] = v.trim();
      else delete overrides[key];
    }
    const tenant = { ...props.tenant, textOverrides: overrides };
    const s = props.sample;
    const start = new Date(s.startsAt);
    const end = new Date(s.endsAt);
    const base = { eventTitle: s.eventTitle, startsAt: start, endsAt: end, location: s.location, name: "Maria Muster" };
    const booking = { ...base, seats: 3, extraAttendees: ["Max Gast", "Lea Gast"], bookingUrl: s.bookingUrl, icsFilename: "termin.ics" };
    switch (group) {
      case "invitation":
        return renderInvitation(tenant, { eventTitle: s.eventTitle, name: "Maria Muster", bookingUrl: s.bookingUrl, validDays: 60, senderName: s.senderName });
      case "changed":
        return renderConfirmation(tenant, { ...booking, seats: 2, extraAttendees: ["Lea Gast"], changed: true, guestCancelled: "Max Gast" });
      case "cancellation":
        return renderCancellation(tenant, { ...base, seats: 3, bookingUrl: s.bookingUrl });
      case "guest":
        return renderGuestConfirmation(tenant, { ...base, name: "Max Gast", bookerName: "Maria Muster", guestUrl: s.bookingUrl, icsFilename: "termin.ics", changed: false });
      case "guestCancelled":
        return renderGuestCancellation(tenant, { ...base, name: "Max Gast" });
      default:
        return renderConfirmation(tenant, { ...booking, changed: false });
    }
  }, [group, values, props.tenant, props.sample]);

  const issueText = (i: TemplateIssue) => t(`templates.issue.${i.kind}`, { p: i.placeholder ?? "" });

  return (
    <form action={props.action} className={styles.brandingGrid}>
      <input type="hidden" name="group" value={group} />
      <div className={styles.brandingFields}>
        <nav aria-label={t("templates.mails")} className={styles.tabsWrap}>
          {MAIL_TEMPLATE_GROUPS.map((g) => {
            const customized = g.keys.some((k) => values[k]?.trim());
            return (
              <button key={g.id} type="button" className={styles.tab} aria-pressed={g.id === group} onClick={() => setGroup(g.id)}>
                {t(`templates.group.${g.id}`)}
                {customized && <span className={styles.dot} aria-label={t("templates.customized")} />}
              </button>
            );
          })}
        </nav>

        {/* alle Felder bleiben im Formular (versteckte Gruppen), damit nichts verloren geht */}
        {MAIL_TEMPLATE_GROUPS.map((g) => (
          <fieldset key={g.id} className={styles.fieldset} hidden={g.id !== group}>
            <legend>{t(`templates.group.${g.id}`)}</legend>
            <div className={styles.brandingFields}>
              {g.keys.map((k) => {
                const id = `tpl-${k.replace(/\./g, "-")}`;
                const v = values[k] ?? "";
                const own = issues.filter((i) => i.key === k);
                const ph = allowedPlaceholders(k);
                const long = props.defaults[k]!.length > 60;
                const common = {
                  id,
                  name: `t.${k}`,
                  value: v,
                  placeholder: props.defaults[k],
                  maxLength: 500,
                  "aria-invalid": own.length > 0 || undefined,
                  "aria-describedby": `${id}-hint`,
                  className: own.length ? styles.inputBad : undefined,
                };
                const set = (x: string) => setValues((s) => ({ ...s, [k]: x }));
                return (
                  <div key={k} className={styles.field}>
                    <label htmlFor={id}>
                      {t(`templates.key.${k}`)}
                      {v.trim() && <span className={styles.tag}>{t("templates.customized")}</span>}
                    </label>
                    {long ? (
                      <textarea {...common} rows={3} className={`${styles.textarea} ${own.length ? styles.inputBad : ""}`} onChange={(e) => set(e.target.value)} />
                    ) : (
                      <input {...common} onChange={(e) => set(e.target.value)} />
                    )}
                    <span id={`${id}-hint`} className={styles.hint}>
                      {ph.length ? t("templates.placeholders", { list: ph.map((p) => `{${p}}`).join(", ") }) : t("templates.noPlaceholders")}
                      {v.trim() && (
                        <>
                          {" · "}
                          <button type="button" className={styles.linkButton} onClick={() => set("")}>
                            {t("templates.reset")}
                          </button>
                        </>
                      )}
                    </span>
                    {own.map((i, n) => (
                      <span key={n} className={styles.fieldError}>
                        {issueText(i)}
                      </span>
                    ))}
                  </div>
                );
              })}
            </div>
          </fieldset>
        ))}

        <div className={styles.actions}>
          <button type="submit" className={styles.btn} disabled={issues.length > 0}>
            {t("templates.save")}
          </button>
        </div>
      </div>

      <div className={styles.previewWrap}>
        <div className={styles.previewLabel}>{t("templates.preview")}</div>
        <div className={styles.mailSubject}>{t("templates.previewSubject", { subject: mail.subject })}</div>
        <iframe title={t("templates.preview")} className={styles.mailPreview} sandbox="" srcDoc={mail.html} />
      </div>
    </form>
  );
}
