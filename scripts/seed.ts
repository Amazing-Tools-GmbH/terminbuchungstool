/**
 * Spielt die Seed-Mandanten ein (idempotent: vorhandene Seed-Mandanten
 * werden vorher gelöscht). Läuft mit der Verbindungsrolle der DB (wie
 * service_role, umgeht RLS). Belegte Plätze entstehen über public.book_slot,
 * also über denselben Weg wie echte Buchungen.
 *
 * Aufruf: npm run db:seed   (bzw. automatisch in npm run db:reset)
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { requireEnv } from "./env";
import { SEED_TENANTS, type SeedTenant } from "../seed/tenants";
import { themeInputSchema } from "../lib/theme/schema";
import { generateToken, hashToken } from "../lib/booking/tokens";
import { assetStorage } from "../lib/storage";

export type SeededInvitation = { slug: string; token: string; tenantId: string };

const ROOT = path.resolve(import.meta.dirname, "..");
const TZ = "Europe/Vienna";

function localDate(inDays: number): string {
  const d = new Date(Date.now() + inDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

async function seedTenant(db: pg.Client, t: SeedTenant, opts: { withAuthUsers: boolean }): Promise<SeededInvitation> {
  const theme = themeInputSchema.parse(t.theme); // Seed muss ein gültiges Theme haben

  await db.query("delete from public.tenants where slug = $1", [t.slug]);
  const {
    rows: [tenant],
  } = await db.query<{ id: string }>(
    `insert into public.tenants (slug, name, anrede, theme, claim, contact_line, legal_links, sender_name, timezone)
     values ($1, $2, $3, $4, $5, $6, $7, $2, $8) returning id`,
    [t.slug, t.name, t.anrede, theme, t.claim, t.contactLine, JSON.stringify(t.legalLinks), TZ],
  );
  const tenantId = tenant!.id;

  // Logo hochladen (lokal: public/dev-assets, später Supabase Storage)
  if (t.logoFile) {
    const key = `${tenantId}/logo${path.extname(t.logoFile)}`;
    await assetStorage().put(key, await readFile(path.join(ROOT, t.logoFile)), "image/svg+xml");
    await db.query("update public.tenants set logo_path = $2 where id = $1", [tenantId, key]);
  }

  // Admin-Benutzer nur in der lokalen Übergangsumgebung (auth.users ist ein Shim).
  // Auf Supabase legen wir Benutzer über die Auth-Admin-API an (Phase 3).
  if (opts.withAuthUsers) {
    const {
      rows: [user],
    } = await db.query<{ id: string }>(
      `insert into auth.users (email) values ($1)
       on conflict (email) do update set email = excluded.email returning id`,
      [t.admin.email],
    );
    await db.query("insert into public.tenant_members (tenant_id, user_id, role) values ($1, $2, 'owner')", [
      tenantId,
      user!.id,
    ]);
  }

  // Postfach: lokal die dev-Implementierung (Mails landen nur in der DB)
  await db.query(
    `insert into public.mail_connections (tenant_id, scope, provider, sender_email, sender_name, status, last_verified_at)
     values ($1, 'tenant', 'dev', $2, $3, 'active', now())`,
    [tenantId, t.senderEmail, t.name],
  );

  const {
    rows: [event],
  } = await db.query<{ id: string }>(
    `insert into public.events (tenant_id, title, location, description, status)
     values ($1, $2, $3, $4, 'published') returning id`,
    [tenantId, t.event.title, t.event.location, t.event.description],
  );

  let filler = 0;
  for (const s of t.event.slots) {
    const day = localDate(s.inDays);
    const {
      rows: [slot],
    } = await db.query<{ id: string }>(
      `insert into public.slots (tenant_id, event_id, starts_at, ends_at, capacity)
       values ($1, $2, ($3 || ' ' || $4)::timestamp at time zone $6, ($3 || ' ' || $5)::timestamp at time zone $6, $7)
       returning id`,
      [tenantId, event!.id, day, s.from, s.to, TZ, s.capacity],
    );
    // Belegung über echte Buchungen herstellen (Blöcke à max. 4 Plätze)
    let remaining = s.booked;
    while (remaining > 0) {
      const seats = Math.min(4, remaining);
      remaining -= seats;
      filler += 1;
      const token = generateToken();
      await db.query(
        `insert into public.invitations (tenant_id, event_id, token_hash, name, email, expires_at)
         values ($1, $2, $3, $4, $5, now() + interval '90 days')`,
        [tenantId, event!.id, hashToken(token), `Seed-Kunde ${filler}`, `seed-kunde-${filler}@kunde.example`],
      );
      await db.query("select public.book_slot($1, $2, $3, $4, $5, $6, '{}')", [
        tenantId,
        token,
        slot!.id,
        seats,
        `Seed-Kunde ${filler}`,
        `seed-kunde-${filler}@kunde.example`,
      ]);
    }
  }

  // Bestätigungsmails der Seed-Buchungen nicht versenden
  await db.query("delete from public.email_outbox where tenant_id = $1", [tenantId]);

  // Test-Einladung zum Ausprobieren
  const token = generateToken();
  await db.query(
    `insert into public.invitations (tenant_id, event_id, token_hash, name, email, pipedrive_deal_id, expires_at, sent_at)
     values ($1, $2, $3, $4, $5, $6, now() + interval '60 days', now())`,
    [tenantId, event!.id, hashToken(token), t.invitation.name, t.invitation.email, t.invitation.pipedriveDealId],
  );

  return { slug: t.slug, token, tenantId };
}

export async function runSeed(connectionString: string, opts: { quiet?: boolean } = {}): Promise<SeededInvitation[]> {
  const db = new pg.Client({ connectionString });
  await db.connect();
  const result: SeededInvitation[] = [];
  try {
    await db.query("begin");
    for (const t of SEED_TENANTS) {
      result.push(await seedTenant(db, t, { withAuthUsers: !process.env.SUPABASE_URL }));
    }
    await db.query("commit");
  } catch (err) {
    await db.query("rollback");
    throw err;
  } finally {
    await db.end();
  }

  if (!opts.quiet) {
    const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
    console.log("\nSeed eingespielt. Test-Buchungslinks:");
    for (const r of result) console.log(`  ${r.slug.padEnd(20)} ${base}/b/${r.token}?tenant=${r.slug}`);
    console.log("");
  }
  return result;
}

// Direkt aufgerufen (npm run db:seed)?
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runSeed(process.env.SUPABASE_DB_URL || requireEnv("DATABASE_URL"));
}
