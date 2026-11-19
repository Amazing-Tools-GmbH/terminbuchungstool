/** Von Supabase verwaltete Schemas – die gehören nicht uns und werden nie angefasst. */
export const SYSTEM_SCHEMAS = `('pg_catalog','information_schema','pg_toast','auth','storage','realtime','_realtime',
  'supabase_functions','supabase_migrations','extensions','graphql','graphql_public','net','pgsodium',
  'pgsodium_masks','vault','pgbouncer','_analytics','cron')`;
