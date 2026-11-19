type Env = Record<string, string | undefined>;

/** Ziel für das Anlegen von auth-Benutzern – immer explizit (AUTH_ADMIN) */
export function authAdminTarget(env: Env = process.env): "local" | "supabase" {
  const v = env.AUTH_ADMIN?.trim();
  if (v === "local" || v === "supabase") return v;
  throw new Error("AUTH_ADMIN fehlt oder ist ungültig: local oder supabase setzen (siehe .env.example)");
}
