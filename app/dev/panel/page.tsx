import { notFound } from "next/navigation";
import { createHmac } from "node:crypto";
import { withActor } from "@/lib/db";
import { devToolsEnabled } from "@/lib/dev-tools";
import { settingsJwtSecret } from "@/lib/pipedrive/settings-token";
import { withBasePath } from "@/lib/base-path";
import { SEED_TENANTS } from "@/seed/tenants";

export const dynamic = "force-dynamic";

type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function signedToken(secret: string, userId: number, companyId: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ userId, companyId, iat: now, exp: now + 300 })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

/**
 * Entwicklung: simuliert den Aufruf des Panels aus einem Pipedrive-Deal
 * (signiertes Token wie von Pipedrive, Seed-Firmen und -Deals).
 */
export default async function DevPanelPage({ searchParams }: { searchParams: Search }) {
  if (!devToolsEnabled()) notFound();
  const sp = await searchParams;
  const secret = settingsJwtSecret();

  const members = await withActor({ role: "service_role" }, async (db) => {
    const { rows } = await db.query<{ slug: string; pd: string; name: string | null; status: string }>(
      `select t.slug, m.pipedrive_user_id::text as pd, m.display_name as name, m.status::text as status
         from public.tenant_members m join public.tenants t on t.id = m.tenant_id
        where m.pipedrive_user_id is not null order by t.slug, m.pipedrive_user_id`,
    );
    return rows;
  });
  const options = members.flatMap((m) => {
    const seed = SEED_TENANTS.find((t) => t.slug === m.slug);
    return seed ? [{ ...m, companyId: seed.pipedrive.companyId, deals: seed.pipedrive.deals ?? [] }] : [];
  });

  const sel = options.find((o) => `${o.slug}:${o.pd}` === one(sp.user)) ?? options[0];
  const dealId = Number(one(sp.deal) ?? sel?.deals[0]?.id ?? 0);
  const theme = one(sp.theme) === "dark" ? "dark" : "light";
  const src =
    secret && sel && dealId
      ? withBasePath(
          `/panel?${new URLSearchParams({
            resource: "deal",
            view: "details",
            userId: sel.pd,
            companyId: String(sel.companyId),
            selectedIds: String(dealId),
            theme,
            token: signedToken(secret, Number(sel.pd), sel.companyId),
          })}`,
        )
      : null;

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 16, display: "grid", gap: 16, gridTemplateColumns: "minmax(0, 360px) minmax(0, 1fr)" }}>
      <form method="get" style={{ display: "grid", gap: 8, alignContent: "start" }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>Entwicklung: Panel im Deal</h1>
        {!secret && <p role="alert">PIPEDRIVE_JWT_SECRET bzw. PIPEDRIVE_CLIENT_SECRET fehlt – ohne Geheimnis kein Token.</p>}
        <label htmlFor="u">Benutzer (Pipedrive)</label>
        <select id="u" name="user" defaultValue={sel ? `${sel.slug}:${sel.pd}` : undefined}>
          {options.map((o) => (
            <option key={`${o.slug}:${o.pd}`} value={`${o.slug}:${o.pd}`}>
              {o.slug} · {o.name ?? o.pd} ({o.status})
            </option>
          ))}
        </select>
        <label htmlFor="d">Deal</label>
        <select id="d" name="deal" defaultValue={String(dealId)}>
          {SEED_TENANTS.flatMap((t) => (t.pipedrive.deals ?? []).map((d) => ({ ...d, slug: t.slug }))).map((d) => (
            <option key={d.id} value={d.id}>
              {d.slug} · {d.id} · {d.title}
            </option>
          ))}
        </select>
        <label>
          <input type="checkbox" name="theme" value="dark" defaultChecked={theme === "dark"} /> dunkles Pipedrive-Theme
        </label>
        <button type="submit">Panel laden</button>
        <p style={{ fontSize: 12, color: "#555" }}>Der Deal muss zur Firma des Benutzers passen; Kontaktdaten kommen aus den Seed-Deals (PIPEDRIVE_DIRECTORY=fake).</p>
      </form>
      {src && <iframe title="Panel" src={src} style={{ width: 360, height: 900, border: "1px solid #ccc", borderRadius: 6, maxWidth: "100%" }} />}
    </main>
  );
}
