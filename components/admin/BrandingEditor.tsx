"use client";
/**
 * Farben & Schriften mit Live-Vorschau. Die Farbwahl liegt beim Kunden – kein
 * Kontrast-Check. Gespeichert wird über die Server Action (prüft das Format streng).
 */
import { useMemo, useState } from "react";
import { BRANDING_COLORS, BRANDING_GROUPS, normalizeColor, type BrandingColorKey } from "@/lib/admin/branding-logic";
import { DEFAULT_THEME, parseTheme, themeInputSchema } from "@/lib/theme/schema";
import { FONT_NAMES } from "@/lib/theme/font-names";
import { colorsOf } from "@/lib/theme/contrast";
import { formatText } from "@/lib/texts";
import styles from "./Admin.module.css";

type Props = {
  action: (form: FormData) => void | Promise<void>;
  texts: Record<string, string>;
  preview: { name: string; logoUrl: string | null; heroIntro: string; submit: string; change: string; slotsTitle: string };
  initial: { claim: string; fontBody: string; fontDisplay: string; colors: Record<BrandingColorKey, string> };
};

const HEX6 = /^#[0-9a-fA-F]{6}$/;

export function BrandingEditor({ action, texts, preview, initial }: Props) {
  const t = (k: string, v?: Record<string, string | number>) => formatText(texts[k] ?? k, v);
  const [claim, setClaim] = useState(initial.claim);
  const [fontBody, setFontBody] = useState(initial.fontBody);
  const [fontDisplay, setFontDisplay] = useState(initial.fontDisplay);
  const [colors, setColors] = useState(initial.colors);

  const valid = (key: BrandingColorKey, v: string) => themeInputSchema.safeParse({ [key]: normalizeColor(v) }).success;
  // Vorschau nur mit gültigen Werten (ungültige -> zuletzt gespeicherter Wert)
  const theme = useMemo(() => {
    const raw: Record<string, string> = { fontBody, fontDisplay };
    for (const c of BRANDING_COLORS) raw[c.key] = valid(c.key, colors[c.key]) ? normalizeColor(colors[c.key]) : initial.colors[c.key];
    return parseTheme(raw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colors, fontBody, fontDisplay]);
  const invalid = BRANDING_COLORS.filter((c) => !valid(c.key, colors[c.key])).map((c) => c.key);

  const font = (name: string) => `var(--font-${name.toLowerCase().replace(/\s+/g, "-")}), ${name}, system-ui, sans-serif`;

  return (
    <form action={action} className={styles.brandingGrid}>
      <div className={styles.brandingFields}>
        <div className={styles.field}>
          <label htmlFor="branding-claim">{t("branding.claim")}</label>
          <input id="branding-claim" name="claim" value={claim} maxLength={120} onChange={(e) => setClaim(e.target.value)} aria-describedby="branding-claim-hint" />
          <span id="branding-claim-hint" className={styles.hint}>
            {t("branding.claimHint")}
          </span>
        </div>
        <div className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="branding-font-display">{t("branding.fontDisplay")}</label>
            <select id="branding-font-display" name="fontDisplay" value={fontDisplay} onChange={(e) => setFontDisplay(e.target.value)}>
              {FONT_NAMES.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="branding-font-body">{t("branding.fontBody")}</label>
            <select id="branding-font-body" name="fontBody" value={fontBody} onChange={(e) => setFontBody(e.target.value)}>
              {FONT_NAMES.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </div>
        </div>

        {BRANDING_GROUPS.map((g) => (
          <fieldset key={g} className={styles.fieldset}>
            <legend>{t(`branding.group.${g}`)}</legend>
            <div className={styles.colorList}>
              {BRANDING_COLORS.filter((c) => c.group === g).map((c) => {
                const v = colors[c.key];
                const id = `branding-${c.key}`;
                const bad = invalid.includes(c.key);
                const isPaint = "paint" in c && c.paint;
                // bei Verläufen zeigt der Farbwähler die erste Farbe (Auswahl ersetzt den Verlauf)
                const first = normalizeColor(colorsOf(v)[0] ?? "");
                const swatch = HEX6.test(normalizeColor(v)) ? normalizeColor(v) : HEX6.test(first) ? first : "#000000";
                return (
                  <div key={c.key} className={`${styles.colorRow} ${isPaint ? styles.full : ""}`}>
                    <label htmlFor={id}>{t(`branding.color.${c.key}`)}</label>
                    <div className={styles.colorInputs}>
                      <input
                        type="color"
                        value={swatch}
                        aria-label={`${t(`branding.group.${g}`)} – ${t(`branding.color.${c.key}`)}`}
                        onChange={(e) => setColors((s) => ({ ...s, [c.key]: e.target.value.toUpperCase() }))}
                      />
                      <input
                        id={id}
                        name={`color.${c.key}`}
                        value={v}
                        maxLength={300}
                        spellCheck={false}
                        aria-invalid={bad || undefined}
                        aria-describedby={isPaint ? `${id}-hint` : undefined}
                        className={bad ? styles.inputBad : undefined}
                        onChange={(e) => setColors((s) => ({ ...s, [c.key]: e.target.value }))}
                      />
                    </div>
                    {isPaint && (
                      <span id={`${id}-hint`} className={styles.hint}>
                        {t("branding.paintHint")}
                      </span>
                    )}
                    {invalid.includes(c.key) && <span className={styles.fieldError}>{t("branding.invalidColor")}</span>}
                  </div>
                );
              })}
            </div>
          </fieldset>
        ))}

        <div className={styles.actions}>
          <button type="submit" className={styles.btn} disabled={invalid.length > 0}>
            {t("branding.save")}
          </button>
          <button
            type="button"
            className={styles.btnGhost}
            onClick={() => {
              setColors(Object.fromEntries(BRANDING_COLORS.map((c) => [c.key, DEFAULT_THEME[c.key]])) as Record<BrandingColorKey, string>);
              setFontBody(DEFAULT_THEME.fontBody);
              setFontDisplay(DEFAULT_THEME.fontDisplay);
            }}
            aria-describedby="branding-reset-hint"
          >
            {t("branding.reset")}
          </button>
        </div>
        <span id="branding-reset-hint" className={styles.hint}>
          {t("branding.resetHint")}
        </span>
      </div>

      {/* Vorschau der Buchungsseite (nur Darstellung) */}
      <div className={styles.previewWrap} aria-label={t("branding.preview")} role="img">
        <div className={styles.previewLabel}>{t("branding.preview")}</div>
        <div className={styles.preview} style={{ background: theme.bg, color: theme.ink, fontFamily: font(theme.fontBody) }}>
          <div className={styles.previewHeader} style={{ background: theme.headerBg, color: theme.headerInk, borderBottom: `1px solid ${theme.headerLine}` }}>
            {preview.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview.logoUrl} alt="" className={styles.previewLogo} />
            ) : (
              <strong style={{ fontFamily: font(theme.fontDisplay) }}>{preview.name}</strong>
            )}
            {claim.trim() && <span className={styles.previewClaim}>{claim.trim()}</span>}
          </div>
          <div style={{ height: 6, background: theme.accentStrip }} />
          <div className={styles.previewHero} style={{ background: theme.heroBg, color: theme.heroInk }}>
            <div style={{ fontFamily: font(theme.fontDisplay), fontWeight: 800, fontSize: 20 }}>{t("branding.preview.heroTitle")}</div>
            <div style={{ color: theme.heroSub, fontSize: 13 }}>{preview.heroIntro}</div>
          </div>
          <div className={styles.previewBody}>
            <div style={{ fontWeight: 700, fontFamily: font(theme.fontDisplay) }}>{preview.slotsTitle}</div>
            <div className={styles.previewCard} style={{ background: theme.surface, border: `1px solid ${theme.line}`, borderRadius: theme.radiusSm }}>
              {t("branding.preview.card")}
            </div>
            <div className={styles.previewButton} style={{ background: theme.primary, color: theme.onPrimary, borderRadius: theme.radiusSm }}>
              {preview.submit} ›
            </div>
            <span style={{ color: theme.link, textDecoration: "underline", fontWeight: 600 }}>{preview.change}</span>
          </div>
        </div>
      </div>
    </form>
  );
}
