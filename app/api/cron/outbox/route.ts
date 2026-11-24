import { timingSafeEqual } from "node:crypto";
import { getPool } from "@/lib/db/pool";
import { processOutbox } from "@/lib/mail/outbox";
import { runPipedriveJobs } from "@/lib/pipedrive/runtime";
import { purgeExpiredData } from "@/lib/retention";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Verarbeitet Mail-Outbox und Pipedrive-Aufträge und löscht abgelaufene
 * personenbezogene Daten (Server-Cron/systemd-Timer,
 * Header "Authorization: Bearer <CRON_SECRET>").
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  if (!secret || auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const mail = await processOutbox(getPool(), { limit: 50 });
  const pipedrive = await runPipedriveJobs({ limit: 50 });
  // Löschfrist: je Mandant höchstens einmal am Tag (die Funktion prüft das selbst)
  const purged = await purgeExpiredData(getPool()).catch((err) => {
    console.error("Löschroutine fehlgeschlagen", err);
    return null;
  });
  return Response.json({ ok: true, ...mail, pipedrive, purged });
}
