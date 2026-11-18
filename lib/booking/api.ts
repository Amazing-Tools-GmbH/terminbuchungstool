import "server-only";
import { after } from "next/server";
import { ANON, withActor } from "@/lib/db";
import { getPool } from "@/lib/db/pool";
import { processOutbox } from "@/lib/mail/outbox";
import { createTranslator } from "@/lib/texts";
import type { PublicTenant } from "@/lib/tenant/types";
import { BookingError, httpStatusFor, messageKeyFor } from "./errors";

export const runAnon = <T,>(fn: Parameters<typeof withActor<T>>[1]) => withActor(ANON, fn);

/** Nach der Antwort: fällige Mails des Mandanten gleich verschicken (Cron ist das Netz) */
export function sendMailsSoon(tenantId: string) {
  after(async () => {
    try {
      await processOutbox(getPool(), { tenantId, limit: 5 });
    } catch (err) {
      console.error("Outbox-Verarbeitung nach Buchung fehlgeschlagen", err);
    }
  });
}

export function errorResponse(tenant: PublicTenant, err: unknown): Response {
  const t = createTranslator(tenant.anrede, tenant.textOverrides);
  if (err instanceof BookingError) {
    return Response.json(
      { ok: false, error: err.code, message: t(messageKeyFor(err.code)), detail: err.detail ?? null },
      { status: httpStatusFor(err.code) },
    );
  }
  console.error("Unerwarteter Fehler bei Buchung", err);
  return Response.json({ ok: false, error: "internal", message: t("error.generic") }, { status: 500 });
}
