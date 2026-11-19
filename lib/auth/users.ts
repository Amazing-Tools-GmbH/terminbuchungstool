import "server-only";
/**
 * Benutzer in auth.users anlegen bzw. finden (beim Freischalten in der
 * Nutzerverwaltung). Es wird KEINE Mail verschickt – angemeldet wird
 * ausschließlich über Pipedrive.
 *
 * Ziel explizit über AUTH_ADMIN:
 *   local     lokale Dev-/Testdatenbank, auth.users ist ein Shim (per SQL)
 *   supabase  Supabase Auth-Admin-API (auf Supabase nie auth.users per SQL)
 */
import { withActor } from "@/lib/db";
import { getPool } from "@/lib/db/pool";
import { authAdminTarget } from "./users-target";
import { supabaseSecretKey } from "@/lib/supabase-keys";

type Env = Record<string, string | undefined>;

async function findUserId(email: string): Promise<string | null> {
  return withActor({ role: "service_role" }, async (db) => {
    const { rows } = await db.query<{ id: string | null }>("select public.auth_user_id_by_email($1) as id", [email]);
    return rows[0]?.id ?? null;
  });
}

async function createSupabaseUser(email: string, name: string, env: Env): Promise<void> {
  const url = env.SUPABASE_URL?.replace(/\/$/, "");
  const key = supabaseSecretKey(env);
  if (!url || !key) throw new Error("SUPABASE_URL/SUPABASE_SECRET_KEY fehlen für AUTH_ADMIN=supabase");
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ email, email_confirm: true, user_metadata: { name, login: "pipedrive" } }),
  });
  // 422 = existiert bereits (z. B. gleichzeitig angelegt) -> danach erneut suchen
  if (!res.ok && res.status !== 422) throw new Error(`Supabase Auth: Benutzer konnte nicht angelegt werden (${res.status})`);
}

/** ID des auth-Benutzers mit dieser E-Mail; legt ihn bei Bedarf an. */
export async function ensureAuthUser(emailInput: string, name: string, env: Env = process.env): Promise<string> {
  const email = emailInput.trim().toLowerCase();
  const target = authAdminTarget(env);
  const existing = await findUserId(email);
  if (existing) return existing;

  if (target === "local") {
    const { rows } = await getPool().query<{ id: string }>(
      `insert into auth.users (email, raw_user_meta_data) values ($1, $2)
       on conflict (email) do update set email = excluded.email returning id`,
      [email, { name }],
    );
    return rows[0]!.id;
  }
  await createSupabaseUser(email, name, env);
  const id = await findUserId(email);
  if (!id) throw new Error("Supabase Auth: Benutzer nach dem Anlegen nicht gefunden");
  return id;
}
