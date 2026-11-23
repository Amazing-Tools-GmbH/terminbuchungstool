import { requireAdmin } from "@/lib/auth/admin";
import { flashMessages } from "@/lib/admin/messages";
import { MAIL_TEMPLATE_GROUPS } from "@/lib/admin/mail-templates";
import { listEvents } from "@/lib/admin/slots";
import { appBaseUrl } from "@/lib/links";
import { TEXTS } from "@/lib/texts";
import { ADMIN_TEXTS, at } from "@/lib/texts/admin";
import { MailTemplatesEditor } from "@/components/admin/MailTemplatesEditor";
import styles from "@/components/admin/Admin.module.css";
import { saveTemplatesAction } from "./actions";

type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function TemplatesPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const sp = await searchParams;
  const { ok, error } = flashMessages(sp);
  const t = ctx.tenant;
  const events = await listEvents(ctx);
  const texts = Object.fromEntries(Object.entries(ADMIN_TEXTS).filter(([k]) => k.startsWith("templates.")));
  const keys = MAIL_TEMPLATE_GROUPS.flatMap((g) => g.keys);
  // Beispieltermin: in einer Woche, volle Stunde
  const sampleStart = new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 7 * 86_400_000);
  const group = MAIL_TEMPLATE_GROUPS.some((g) => g.id === one(sp.mail)) ? one(sp.mail)! : MAIL_TEMPLATE_GROUPS[0]!.id;

  return (
    <>
      <h1 className={styles.h1}>{at("templates.title")}</h1>
      <p className={styles.muted} style={{ margin: 0 }}>
        {at("templates.intro")}
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
      <MailTemplatesEditor
        action={saveTemplatesAction}
        texts={texts}
        initialGroup={group}
        defaults={Object.fromEntries(keys.map((k) => [k, TEXTS[k][t.anrede]]))}
        values={Object.fromEntries(keys.map((k) => [k, t.textOverrides[k] ?? ""]))}
        tenant={{
          name: t.name,
          theme: t.theme,
          anrede: t.anrede,
          textOverrides: t.textOverrides,
          contactLine: t.contactLine,
          legalLinks: t.legalLinks,
          timezone: t.timezone,
          changeDeadlineHours: t.changeDeadlineHours,
          // wie beim Versand: SVG zeigen viele Mail-Programme nicht -> Name als Text
          logoUrl: t.logoUrl && /\.(png|jpe?g)$/i.test(t.logoUrl) ? t.logoUrl : null,
        }}
        sample={{
          eventTitle: events[0]?.title ?? at("templates.sample.event"),
          location: events[0]?.location ?? at("templates.sample.location"),
          senderName: ctx.name ?? t.name,
          bookingUrl: `${appBaseUrl()}/b/beispiel-link`,
          startsAt: sampleStart.toISOString(),
          endsAt: new Date(sampleStart.getTime() + 2 * 3_600_000).toISOString(),
        }}
      />
    </>
  );
}
