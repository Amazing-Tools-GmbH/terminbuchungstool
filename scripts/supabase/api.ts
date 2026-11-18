/**
 * Zugriff auf das Supabase-Projekt über HTTPS (ohne direkte DB-Verbindung):
 *   * SQL über die Management API  (SUPABASE_ACCESS_TOKEN, Projekt-Ref aus SUPABASE_URL)
 *   * Storage/Auth über die Projekt-API (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
 * Nur für Betriebsskripte (Migration, Seed, Bestandsaufnahme) – nie in der App.
 */
import pg from "pg";
import { requireEnv } from "../env";

export function projectRef(): string {
  const url = new URL(requireEnv("SUPABASE_URL"));
  const ref = url.hostname.split(".")[0];
  if (!ref || !/^[a-z0-9]{20}$/.test(ref)) throw new Error("Projekt-Ref aus SUPABASE_URL nicht ableitbar");
  return ref;
}

/**
 * Führt SQL über die Management API aus (Rolle postgres). Mehrere Anweisungen
 * in einem Aufruf laufen in einer Sitzung; ein explizites begin/commit im
 * Skript macht sie atomar. Liefert die Zeilen der letzten Anweisung.
 */
export async function managementQuery<R = Record<string, unknown>>(sql: string): Promise<R[]> {
  const token = requireEnv("SUPABASE_ACCESS_TOKEN");
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef()}/database/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Management API ${res.status}: ${text.slice(0, 2000)}`);
  return text ? (JSON.parse(text) as R[]) : [];
}

/** Wert als SQL-Literal (für Skripte, die nicht mit Bind-Parametern laufen können). */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`Ungültige Zahl: ${v}`);
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return pg.escapeLiteral(v);
  if (v instanceof Date) return pg.escapeLiteral(v.toISOString());
  if (v instanceof Uint8Array) return `'\\x${Buffer.from(v).toString("hex")}'::bytea`; // bytea (z. B. Token-Hash)
  return pg.escapeLiteral(JSON.stringify(v)); // Objekte/Arrays wie pg: als JSON
}

/** Ersetzt $1..$n durch Literale. Nur für eigene SQL-Texte ohne "$n" in Zeichenketten. */
export function inlineParams(sql: string, params: readonly unknown[] = []): string {
  return sql.replace(/\$(\d+)\b/g, (_m, n: string) => {
    const i = Number(n) - 1;
    if (i < 0 || i >= params.length) throw new Error(`Parameter $${n} fehlt`);
    return sqlLiteral(params[i]);
  });
}

/** Aufruf der Projekt-API (Storage, Auth-Admin) mit Service-Role-Key. */
export async function projectApi<T = unknown>(pathname: string, init: RequestInit = {}): Promise<T> {
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const res = await fetch(`${requireEnv("SUPABASE_URL")}${pathname}`, {
    ...init,
    headers: { apikey: key, authorization: `Bearer ${key}`, ...((init.headers as Record<string, string>) ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${pathname} → ${res.status}: ${text.slice(0, 1000)}`);
  return (text ? JSON.parse(text) : null) as T;
}
