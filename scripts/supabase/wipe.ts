/**
 * LEERT das Supabase-Projekt vollständig (nicht umkehrbar!):
 *   * alle Objekte im Schema public (Tabellen, Views, Funktionen, Typen, Sequenzen)
 *     – das Schema selbst samt Supabase-Standardrechten bleibt erhalten
 *   * eigene Schemas außer den von Supabase verwalteten (z. B. "app")
 *   * Migrationshistorie (supabase_migrations.schema_migrations)
 *   * Vault-Secrets, alle Storage-Buckets inkl. Dateien, alle Auth-Benutzer
 * Extensions und Supabase-Systemschemas bleiben unangetastet.
 *
 * Nur mit ausdrücklicher Bestätigung des Projekt-Refs:
 *   npm run supabase:wipe -- --confirm=<projekt-ref>
 */
import { managementQuery, projectApi, projectRef } from "./api";
import { SYSTEM_SCHEMAS } from "./schemas";

const ref = projectRef();
if (!process.argv.includes(`--confirm=${ref}`)) {
  console.error(`Abbruch: Löschen nur mit --confirm=${ref}`);
  process.exit(1);
}

// 1) Datenbank: alles in einer Abfrage (implizite Transaktion)
await managementQuery(`
do $wipe$
declare r record;
begin
  -- eigene Schemas (alles außer Supabase-/System-Schemas und public)
  for r in select nspname from pg_namespace
            where nspname not in ${SYSTEM_SCHEMAS} and nspname <> 'public' and nspname not like 'pg\\_%'
  loop
    execute format('drop schema %I cascade', r.nspname);
  end loop;

  -- public: Views, Tabellen, Sequenzen, Funktionen, Typen (nicht aus Extensions)
  for r in select c.relname, c.relkind from pg_class c
            where c.relnamespace = 'public'::regnamespace and c.relkind in ('v','m')
              and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
  loop
    execute format(case r.relkind when 'v' then 'drop view if exists public.%I cascade'
                                  else 'drop materialized view if exists public.%I cascade' end, r.relname);
  end loop;
  for r in select c.relname from pg_class c
            where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','f')
              and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
  loop
    execute format('drop table if exists public.%I cascade', r.relname);
  end loop;
  for r in select c.relname from pg_class c
            where c.relnamespace = 'public'::regnamespace and c.relkind = 'S'
              and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
  loop
    execute format('drop sequence if exists public.%I cascade', r.relname);
  end loop;
  for r in select p.oid::regprocedure as sig, p.prokind from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format(case r.prokind when 'p' then 'drop procedure if exists %s cascade'
                                  when 'a' then 'drop aggregate if exists %s cascade'
                                  else 'drop function if exists %s cascade' end, r.sig);
  end loop;
  for r in select t.typname from pg_type t
            where t.typnamespace = 'public'::regnamespace and t.typtype in ('e','c','d','r')
              and (t.typrelid = 0 or exists (select 1 from pg_class c where c.oid = t.typrelid and c.relkind = 'c'))
              and not exists (select 1 from pg_depend d where d.objid = t.oid and d.deptype = 'e')
  loop
    execute format('drop type if exists public.%I cascade', r.typname);
  end loop;

  -- Migrationshistorie
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    delete from supabase_migrations.schema_migrations;
  end if;

  -- Vault-Secrets
  if to_regclass('vault.secrets') is not null then
    delete from vault.secrets;
  end if;
end
$wipe$;
`);
console.log("✓ Datenbank geleert (public, eigene Schemas, Migrationshistorie, Vault)");

// 2) Storage: Buckets leeren und löschen (direktes SQL auf storage.* ist gesperrt)
const buckets = await projectApi<{ id: string }[]>("/storage/v1/bucket");
for (const b of buckets) {
  await projectApi(`/storage/v1/bucket/${encodeURIComponent(b.id)}/empty`, { method: "POST" });
  await projectApi(`/storage/v1/bucket/${encodeURIComponent(b.id)}`, { method: "DELETE" });
  console.log(`✓ Bucket gelöscht: ${b.id}`);
}

// 3) Auth-Benutzer über die Admin-API
for (;;) {
  const { users } = await projectApi<{ users: { id: string }[] }>("/auth/v1/admin/users?per_page=100");
  if (!users.length) break;
  for (const u of users) await projectApi(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" });
  console.log(`✓ ${users.length} Auth-Benutzer gelöscht`);
}
console.log("Projekt geleert.");
