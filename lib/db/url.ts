/** Supabase hat Vorrang; sonst die lokale Übergangsdatenbank. */
export function databaseUrl(): string {
  const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("Weder SUPABASE_DB_URL noch DATABASE_URL gesetzt (siehe .env.example)");
  return url;
}
