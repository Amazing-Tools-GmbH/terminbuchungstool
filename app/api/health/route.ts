import { getPool } from "@/lib/db/pool";

export const dynamic = "force-dynamic";

/** Lebenszeichen für Deploy-Prüfung/Monitoring: App läuft und erreicht die Datenbank. Keine Details nach außen. */
export async function GET() {
  try {
    await Promise.race([
      getPool().query("select 1"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
    ]);
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
