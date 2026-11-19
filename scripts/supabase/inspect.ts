/**
 * Bestandsaufnahme des Supabase-Projekts (nur lesend).
 * Aufruf: npm run supabase:inspect
 */
import { managementQuery, projectApi } from "./api";
import { SYSTEM_SCHEMAS } from "./schemas";

async function section(title: string, sql: string) {
  const rows = await managementQuery(sql);
  console.log(`\n## ${title} (${rows.length})`);
  for (const r of rows) console.log("  " + Object.values(r).map((v) => (v === null ? "∅" : String(v))).join(" | "));
}

await section("Verbindung", "select current_user, version()");
await section(
  "Eigene Schemas",
  `select nspname from pg_namespace where nspname not in ${SYSTEM_SCHEMAS} and nspname not like 'pg_%' order by 1`,
);
await section(
  "Tabellen/Views (ohne System-Schemas)",
  `select n.nspname || '.' || c.relname, c.relkind::text, c.reltuples::bigint as zeilen_ca, c.relrowsecurity as rls
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r','v','m','p','f') and n.nspname not in ${SYSTEM_SCHEMAS}
      and n.nspname not like 'pg_%' order by 1`,
);
await section(
  "Funktionen (ohne System-Schemas, ohne Extensions)",
  `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname not in ${SYSTEM_SCHEMAS} and n.nspname not like 'pg_%'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') order by 1`,
);
await section(
  "Typen (Enums/Composites/Domains, ohne System-Schemas)",
  `select n.nspname || '.' || t.typname, t.typtype::text from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where t.typtype in ('e','c','d') and n.nspname not in ${SYSTEM_SCHEMAS} and n.nspname not like 'pg_%'
      and not exists (select 1 from pg_class c where c.oid = t.typrelid and c.relkind <> 'c')
      and not exists (select 1 from pg_depend d where d.objid = t.oid and d.deptype = 'e') order by 1`,
);
await section(
  "Eigene Trigger auf auth.users",
  `select tgname from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal`,
);
await section(
  "Installierte Extensions",
  `select extname || ' ' || extversion || ' (' || n.nspname || ')' from pg_extension e
     join pg_namespace n on n.oid = e.extnamespace order by 1`,
);
await section("Auth-Benutzer", `select count(*) as anzahl, min(created_at)::date, max(created_at)::date from auth.users`);
const hasMig = await managementQuery<{ t: boolean }>(
  `select to_regclass('supabase_migrations.schema_migrations') is not null as t`,
);
if (hasMig[0]?.t) {
  await section("Migrationen", `select version, name from supabase_migrations.schema_migrations order by version`);
} else {
  console.log("\n## Migrationen: Tabelle supabase_migrations.schema_migrations existiert nicht");
}
await section("Storage-Objekte je Bucket", `select bucket_id, count(*) from storage.objects group by 1 order by 1`);

const buckets = await projectApi<{ id: string; public: boolean }[]>("/storage/v1/bucket");
console.log(`\n## Storage-Buckets (${buckets.length})`);
for (const b of buckets) console.log(`  ${b.id} | public=${b.public}`);
