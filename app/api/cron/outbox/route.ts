import { timingSafeEqual } from "node:crypto";
import { getPool } from "@/lib/db/pool";
import { processOutbox } from "@/lib/mail/outbox";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Verarbeitet die Outbox (Vercel Cron, siehe vercel.json).
 * Vercel sendet "Authorization: Bearer <CRON_SECRET>".
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  if (!secret || auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const result = await processOutbox(getPool(), { limit: 50 });
  return Response.json({ ok: true, ...result });
}
