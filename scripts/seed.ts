/**
 * Spielt die Seed-Mandanten ein (idempotent: vorhandene Seed-Mandanten
 * werden vorher gelöscht). Läuft mit Superuser-/Owner-Rechten (umgeht RLS).
 * Belegte Plätze entstehen über public.book_slot, also über denselben Weg
 * wie echte Buchungen.
 *
 * Das Ziel wird IMMER explizit gewählt – nie aus Umgebungsvariablen geraten:
 *   --target=local     DATABASE_URL (Postgres + Dev-Shims), Logos in .data/dev-assets,
 *                      Admin-Benutzer per SQL in den auth.users-Shim
 *   --target=supabase  SQL über die Supabase Management API, Logos in Supabase
 *                      Storage (Bucket tenant-assets), KEINE auth.users per SQL
 *                      (Benutzer kommen ab Phase 3 über die Auth-Admin-API)
 *
 * Aufruf: npm run db:seed              (local, auch Teil von npm run db:reset)
 *         npm run supabase:seed        (supabase)
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { requireEnv } from "./env";
import { SEED_TENANTS, type SeedTenant } from "../seed/tenants";
import { themeInputSchema } from "../lib/theme/schema";
import { generateToken, hashToken } from "../lib/booking/tokens";
import { ASSET_BUCKET, createAssetStorage } from "../lib/storage";

export type SeedTarget = "local" | "supabase";
export type SeededInvitation = { slug: string; token: string; tenantId: string };

type Stmt = { sql: string; params?: unknown[] };
export type TenantPlan = { statements: Stmt[]; logo: { key: string; file: string } | null; invitation: SeededInvitation };

const ROOT = path.resolve(import.meta.dirname, "..");
const TZ = "Europe/Vienna";

function localDate(inDays: number): string {
  const d = new Date(Date.now() + inDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/**
 * Plant alle Anweisungen eines Mandanten. IDs entstehen hier (randomUUID),
 * damit keine Anweisung auf das Ergebnis einer anderen warten muss – so lässt
 * sich derselbe Plan per pg-Client oder als ein SQL-Skript ausführen.
 */
export function planTenant(t: SeedTenant, target: SeedTarget): TenantPlan {
  const theme = themeInputSchema.parse(t.theme); // Seed muss ein gültiges Theme haben
  const tenantId = randomUUID();
  const eventId = randomUUID();
  const s: Stmt[] = [];
  const logo = t.logoFile ? { key: `${tenantId}/logo${path.extname(t.logoFile)}`, file: t.logoFile } : null;

  s.push({ sql: "delete from public.tenants where slug = $1", params: [t.slug] });
  s.push({
    sql: `insert into public.tenants (id, slug, name, anrede, theme, claim, contact_line, legal_links, sender_name, timezone, logo_path)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $3, $9, $10)`,
    params: [tenantId, t.slug, t.name, t.anrede, theme, t.claim, t.contactLine, JSON.stringify(t.legalLinks), TZ, logo?.key ?? null],
  });

  // Freigeschaltete Benutzer nur lokal (auth.users ist dort ein Shim). Auf
  // Supabase entstehen Benutzer ausschließlich über die Auth-Admin-API
  // (Nutzerverwaltung im Admin-Backend bzw. Pipedrive-Installation).
  if (target === "local") {
    for (const u of t.pipedrive.users) {
      if (!u.access) continue;
      s.push({
        sql: `insert into auth.users (email) values ($1) on conflict (email) do nothing`,
        params: [u.email.toLowerCase()],
      });
      s.push({
        sql: `insert into public.tenant_members (tenant_id, user_id, role, pipedrive_user_id, display_name, email)
              select $1, id, $3, $4, $5, $2 from auth.users where email = $2`,
        params: [tenantId, u.email.toLowerCase(), u.access, u.id, u.name],
      });
    }
  }

  // Postfach: die dev-Implementierung (Mails landen nur in der DB)
  s.push({
    sql: `insert into public.mail_connections (tenant_id, scope, provider, sender_email, sender_name, status, last_verified_at)
          values ($1, 'tenant', 'dev', $2, $3, 'active', now())`,
    params: [tenantId, t.senderEmail, t.name],
  });
  s.push({
    sql: `insert into public.events (id, tenant_id, title, location, description, status)
          values ($1, $2, $3, $4, $5, 'published')`,
    params: [eventId, tenantId, t.event.title, t.event.location, t.event.description],
  });

  let filler = 0;
  for (const slot of t.event.slots) {
    const slotId = randomUUID();
    const day = localDate(slot.inDays);
    s.push({
      sql: `insert into public.slots (id, tenant_id, event_id, starts_at, ends_at, capacity)
            values ($1, $2, $3, ($4::date + $5::time) at time zone $7, ($4::date + $6::time) at time zone $7, $8)`,
      params: [slotId, tenantId, eventId, day, slot.from, slot.to, TZ, slot.capacity],
    });
    // Belegung über echte Buchungen herstellen (Blöcke à max. 4 Plätze)
    let remaining = slot.booked;
    while (remaining > 0) {
      const seats = Math.min(4, remaining);
      remaining -= seats;
      filler += 1;
      const token = generateToken();
      const name = `Seed-Kunde ${filler}`;
      const email = `seed-kunde-${filler}@kunde.example`;
      s.push({
        sql: `insert into public.invitations (tenant_id, event_id, token_hash, name, email, expires_at)
              values ($1, $2, $3, $4, $5, now() + interval '90 days')`,
        params: [tenantId, eventId, hashToken(token), name, email],
      });
      s.push({
        sql: "select public.book_slot($1, $2, $3, $4, $5, $6, '{}', null)",
        params: [tenantId, token, slotId, seats, name, email],
      });
    }
  }

  // Bestätigungsmails der Seed-Buchungen nicht versenden
  s.push({ sql: "delete from public.email_outbox where tenant_id = $1", params: [tenantId] });

  // Test-Einladung zum Ausprobieren
  const token = generateToken();
  s.push({
    sql: `insert into public.invitations (tenant_id, event_id, token_hash, name, organization_name, email, pipedrive_deal_id, expires_at, sent_at)
          values ($1, $2, $3, $4, $5, $6, $7, now() + interval '60 days', now())`,
    params: [tenantId, eventId, hashToken(token), t.invitation.name, t.invitation.organization, t.invitation.email, t.invitation.pipedriveDealId],
  });

  return { statements: s, logo, invitation: { slug: t.slug, token, tenantId } };
}

async function uploadLogos(plans: TenantPlan[], target: SeedTarget) {
  const storage = createAssetStorage(target);
  for (const p of plans) {
    if (p.logo) await storage.put(p.logo.key, await readFile(path.join(ROOT, p.logo.file)), "image/svg+xml");
  }
}

/** Lokale Datenbank: ein pg-Client, eine Transaktion. */
export async function runSeed(connectionString: string, opts: { quiet?: boolean } = {}): Promise<SeededInvitation[]> {
  const plans = SEED_TENANTS.map((t) => planTenant(t, "local"));
  await uploadLogos(plans, "local");

  const db = new pg.Client({ connectionString });
  await db.connect();
  try {
    await db.query("begin");
    for (const p of plans) for (const st of p.statements) await db.query(st.sql, st.params);
    await db.query("commit");
  } catch (err) {
    await db.query("rollback");
    throw err;
  } finally {
    await db.end();
  }
  const result = plans.map((p) => p.invitation);
  if (!opts.quiet) printLinks(result);
  return result;
}

/**
 * Supabase: alle Anweisungen als EIN Skript über die Management API. Mehrere
 * Anweisungen in einer einfachen Abfrage laufen in Postgres als eine
 * implizite Transaktion – bei einem Fehler wird alles zurückgerollt.
 */
export async function runSeedSupabase(opts: { quiet?: boolean } = {}): Promise<SeededInvitation[]> {
  const { managementQuery, inlineParams, projectApi } = await import("./supabase/api");
  const plans = SEED_TENANTS.map((t) => planTenant(t, "supabase"));

  // Logos der bisherigen Seed-Mandanten aus dem Bucket entfernen
  const old = await managementQuery<{ id: string }>(
    inlineParams("select id::text from public.tenants where slug = any($1::text[])", [
      `{${SEED_TENANTS.map((t) => t.slug).join(",")}}`,
    ]),
  );
  for (const { id } of old) {
    const files = await projectApi<{ name: string }[]>(`/storage/v1/object/list/${ASSET_BUCKET}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefix: `${id}/`, limit: 100 }),
    });
    if (files.length) {
      await projectApi(`/storage/v1/object/${ASSET_BUCKET}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prefixes: files.map((f) => `${id}/${f.name}`) }),
      });
    }
  }

  await uploadLogos(plans, "supabase");
  const script = plans.flatMap((p) => p.statements.map((st) => inlineParams(st.sql, st.params) + ";")).join("\n");
  await managementQuery(script);

  const result = plans.map((p) => p.invitation);
  if (!opts.quiet) printLinks(result);
  return result;
}

function printLinks(result: SeededInvitation[]) {
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  console.log("\nSeed eingespielt. Test-Buchungslinks:");
  for (const r of result) console.log(`  ${r.slug.padEnd(20)} ${base}/b/${r.token}?tenant=${r.slug}`);
  console.log("");
}

export function parseTarget(argv: string[]): SeedTarget {
  const arg = argv.find((a) => a.startsWith("--target="))?.slice("--target=".length);
  if (arg !== "local" && arg !== "supabase") {
    throw new Error("Ziel fehlt oder ist ungültig: --target=local oder --target=supabase angeben");
  }
  return arg;
}

// Direkt aufgerufen (npm run db:seed / npm run supabase:seed)?
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const target = parseTarget(process.argv.slice(2));
  if (target === "local") await runSeed(requireEnv("DATABASE_URL"));
  else await runSeedSupabase();
}
