/**
 * E-Mail-Vorlagen (Inhalte: docs/mockup/2-emails.dc.html). Gestaltung folgt
 * Theme und Anrede des Mandanten. E-Mail-Clients können keine CSS-Variablen,
 * Verläufe oder SVG zuverlässig: daher Tabellenlayout, Inline-Styles, nur
 * Volltonfarben (erste Farbe eines Verlaufs) und Logo nur als Rasterbild.
 */
import type { Theme } from "@/lib/theme/schema";
import { colorsOf } from "@/lib/theme/contrast";
import { createTranslator, type Anrede, type TextOverrides } from "@/lib/texts";
import { formatSlot } from "@/lib/datetime";
import type { LegalLink } from "@/lib/tenant/types";

export type MailTenant = {
  name: string;
  theme: Theme;
  anrede: Anrede;
  textOverrides: TextOverrides;
  contactLine: string | null;
  legalLinks: LegalLink[];
  timezone: string;
  changeDeadlineHours: number;
  /** absolute URL eines PNG/JPG-Logos oder null (SVG wird in Mails nicht verwendet) */
  logoUrl: string | null;
};

export type RenderedMail = { subject: string; html: string; text: string };

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Volltonfarbe aus Farbe oder Verlauf */
function solid(paint: string, fallback: string): string {
  return colorsOf(paint)[0] ?? fallback;
}

function fontStack(t: Theme): string {
  return `'${t.fontBody}', Arial, Helvetica, sans-serif`;
}

function layout(tenant: MailTenant, bodyHtml: string, preheader: string): string {
  const t = tenant.theme;
  const brand = tenant.logoUrl
    ? `<img src="${escapeHtml(tenant.logoUrl)}" alt="${escapeHtml(tenant.name)}" height="48" style="display:block;height:48px;width:auto;border:0">`
    : `<span style="font-size:20px;font-weight:800;color:${t.headerInk}">${escapeHtml(tenant.name)}</span>`;
  const legal = tenant.legalLinks
    .map((l) => `<a href="${escapeHtml(l.href)}" style="color:${t.muted};text-decoration:underline">${escapeHtml(l.label)}</a>`)
    .join(" &nbsp;·&nbsp; ");
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(tenant.name)}</title></head>
<body style="margin:0;padding:0;background:${t.bg}">
<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${t.bg}">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${t.surface};border:1px solid ${t.line};border-radius:${t.radius};overflow:hidden;font-family:${fontStack(t)};color:${t.ink}">
<tr><td style="background:${solid(t.headerBg, "#FFFFFF")};padding:16px 28px">${brand}</td></tr>
<tr><td style="height:6px;line-height:6px;font-size:0;background:${solid(t.accentStrip, t.primary)}">&nbsp;</td></tr>
<tr><td style="padding:28px 28px 8px;font-size:16px;line-height:1.55">${bodyHtml}</td></tr>
<tr><td style="padding:16px 28px 24px;font-size:13px;line-height:1.5;color:${t.muted};border-top:1px solid ${t.line}">
${tenant.contactLine ? `${escapeHtml(tenant.contactLine)}<br>` : ""}${legal}
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function button(t: Theme, href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px"><tr><td style="border-radius:${t.radiusSm};background:${t.primary}">
<a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 24px;font-size:16px;font-weight:700;color:${t.onPrimary};text-decoration:none;border-radius:${t.radiusSm}">${escapeHtml(label)}</a>
</td></tr></table>`;
}

function summaryTable(t: Theme, rows: [string, string][]): string {
  const cells = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 0;width:38%;font-size:13px;color:${t.muted};vertical-align:top">${escapeHtml(label)}</td><td style="padding:6px 0;font-size:16px;font-weight:700">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;padding:16px 20px;background:${t.bg};border:1px solid ${t.line};border-radius:${t.radiusSm}">${cells}</table>`;
}

function link(t: Theme, href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="color:${t.link};font-weight:700;text-decoration:underline">${escapeHtml(label)}</a>`;
}

// ---------------------------------------------------------------------------

export type BookingMailData = {
  eventTitle: string;
  startsAt: Date;
  endsAt: Date;
  location: string | null;
  seats: number;
  name: string;
  extraAttendees: string[];
  bookingUrl: string | null;
  icsFilename: string;
  changed: boolean;
};

export function renderConfirmation(tenant: MailTenant, d: BookingMailData): RenderedMail {
  const tr = createTranslator(tenant.anrede, tenant.textOverrides);
  const t = tenant.theme;
  const when = formatSlot(d.startsAt, d.endsAt, tenant.timezone);
  const persons = d.seats === 1 ? tr("mail.person") : tr("mail.persons", { n: d.seats });
  const subject = tr(d.changed ? "mail.confirmation.changedSubject" : "mail.confirmation.subject", {
    event: d.eventTitle,
    date: when.date,
  });
  const title = tr(d.changed ? "mail.confirmation.changedTitle" : "mail.confirmation.title");
  const rows: [string, string][] = [
    [tr("done.date"), `${when.weekdayShort}, ${when.date}`],
    [tr("done.time"), when.time],
    ...(d.location ? ([[tr("done.place"), d.location]] as [string, string][]) : []),
    [tr("done.seats"), persons],
    ...(d.extraAttendees.length ? ([[tr("done.attendees"), d.extraAttendees.join(", ")]] as [string, string][]) : []),
  ];
  const changeLine = d.bookingUrl
    ? tr("mail.change", { hours: tenant.changeDeadlineHours, link: "\u0000" })
    : null;
  const changeHtml = changeLine
    ? escapeHtml(changeLine).replace("\u0000", link(t, d.bookingUrl!, tr("mail.changeLink")))
    : "";
  const html = layout(
    tenant,
    `<p style="margin:0 0 4px;font-size:14px;color:${t.muted}">${escapeHtml(d.eventTitle)}</p>
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;color:${t.ink}">${escapeHtml(title)}</h1>
<p style="margin:0 0 8px">${escapeHtml(tr("mail.greeting", { name: d.name }))}</p>
${summaryTable(t, rows)}
<p style="margin:0 0 16px;font-size:14px;color:${t.muted}">📅 ${escapeHtml(d.icsFilename)} – ${escapeHtml(tr("mail.ics.hint"))}</p>
${changeHtml ? `<p style="margin:0 0 20px;font-size:14px">${changeHtml}</p>` : ""}`,
    `${title}: ${when.weekdayShort}, ${when.date}, ${when.time}`,
  );
  const text = [
    tr("mail.greeting", { name: d.name }),
    "",
    `${title} – ${d.eventTitle}`,
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    `${tr("done.ics")}: ${d.icsFilename}`,
    ...(changeLine && d.bookingUrl ? ["", changeLine.replace("\u0000", tr("mail.changeLink")) + `\n${d.bookingUrl}`] : []),
    "",
    tenant.contactLine ?? "",
  ].join("\n");
  return { subject, html, text };
}

export function renderCancellation(
  tenant: MailTenant,
  d: Omit<BookingMailData, "changed" | "icsFilename" | "extraAttendees">,
): RenderedMail {
  const tr = createTranslator(tenant.anrede, tenant.textOverrides);
  const t = tenant.theme;
  const when = formatSlot(d.startsAt, d.endsAt, tenant.timezone);
  const subject = tr("mail.cancellation.subject", { event: d.eventTitle, date: when.date });
  const title = tr("mail.cancellation.title");
  const rows: [string, string][] = [
    [tr("done.date"), `${when.weekdayShort}, ${when.date}`],
    [tr("done.time"), when.time],
  ];
  const again = d.bookingUrl ? tr("mail.cancellation.text", { link: "\u0000" }) : null;
  const html = layout(
    tenant,
    `<p style="margin:0 0 4px;font-size:14px;color:${t.muted}">${escapeHtml(d.eventTitle)}</p>
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.25">${escapeHtml(title)}</h1>
<p style="margin:0 0 8px">${escapeHtml(tr("mail.greeting", { name: d.name }))}</p>
${summaryTable(t, rows)}
${again ? `<p style="margin:0 0 20px;font-size:14px">${escapeHtml(again).replace("\u0000", link(t, d.bookingUrl!, tr("mail.changeLink")))}</p>` : ""}`,
    title,
  );
  const text = [
    tr("mail.greeting", { name: d.name }),
    "",
    `${title} – ${d.eventTitle}`,
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(again && d.bookingUrl ? ["", again.replace("\u0000", tr("mail.changeLink")) + `\n${d.bookingUrl}`] : []),
    "",
    tenant.contactLine ?? "",
  ].join("\n");
  return { subject, html, text };
}

export type InvitationMailData = {
  eventTitle: string;
  name: string;
  bookingUrl: string;
  validDays: number;
  senderName: string;
};

export function renderInvitation(tenant: MailTenant, d: InvitationMailData): RenderedMail {
  const tr = createTranslator(tenant.anrede, tenant.textOverrides);
  const t = tenant.theme;
  const subject = tr("mail.invitation.subject", { tenant: tenant.name });
  const html = layout(
    tenant,
    `<p style="margin:0 0 4px;font-size:14px;color:${t.muted}">${escapeHtml(tenant.name)}</p>
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.25">${escapeHtml(d.eventTitle)}</h1>
<p style="margin:0 0 12px">${escapeHtml(tr("mail.greeting", { name: d.name }))}</p>
<p style="margin:0 0 12px">${escapeHtml(tr("mail.invitation.text", { event: d.eventTitle }))}</p>
${button(t, d.bookingUrl, tr("mail.invitation.button"))}
<p style="margin:0 0 16px;font-size:14px;color:${t.muted}">${escapeHtml(tr("mail.invitation.validity", { days: d.validDays }))}</p>
<p style="margin:0 0 20px">${escapeHtml(tr("mail.regards"))}<br>${escapeHtml(d.senderName)}</p>`,
    tr("mail.invitation.text", { event: d.eventTitle }),
  );
  const text = [
    tr("mail.greeting", { name: d.name }),
    "",
    tr("mail.invitation.text", { event: d.eventTitle }),
    "",
    `${tr("mail.invitation.button")}: ${d.bookingUrl}`,
    "",
    tr("mail.invitation.validity", { days: d.validDays }),
    "",
    tr("mail.regards"),
    d.senderName,
  ].join("\n");
  return { subject, html, text };
}

export function renderTest(tenant: MailTenant): RenderedMail {
  const tr = createTranslator(tenant.anrede, tenant.textOverrides);
  const subject = tr("mail.test.subject");
  const html = layout(
    tenant,
    `<h1 style="margin:0 0 16px;font-size:22px">${escapeHtml(subject)}</h1><p style="margin:0 0 20px">${escapeHtml(tr("mail.test.text"))}</p>`,
    subject,
  );
  return { subject, html, text: tr("mail.test.text") };
}
