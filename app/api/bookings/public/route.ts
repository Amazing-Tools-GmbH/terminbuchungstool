import { hostCustomDomain, tenantForToken } from "@/lib/tenant/current";
import { publicBookInputSchema } from "@/lib/booking/input";
import { bookPublic } from "@/lib/booking/service";
import { errorResponse, runAnon, sendMailsSoon } from "@/lib/booking/api";
import { createTranslator } from "@/lib/texts";

/** Buchen über den öffentlichen Event-Link (ohne persönliche Einladung) */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const token = typeof body?.token === "string" ? body.token : "";
  const tenant = token ? await tenantForToken(token, await hostCustomDomain()) : null;
  if (!tenant) return Response.json({ ok: false, error: "tenant_not_found" }, { status: 404 });

  const parsed = publicBookInputSchema.safeParse(body);
  if (!parsed.success) {
    const t = createTranslator(tenant.anrede, tenant.textOverrides);
    const field = parsed.error.issues[0]?.path[0];
    const message =
      field === "email" ? t("error.invalid_email") : field === "name" ? t("error.invalid_name") : field === "guests" ? t("error.invalid_guest_email") : t("error.generic");
    return Response.json({ ok: false, error: "invalid_input", field, message }, { status: 400 });
  }

  try {
    const result = await bookPublic(runAnon, tenant, parsed.data);
    sendMailsSoon(tenant.id);
    // persönlicher Link: dort sieht der Kunde seine Bestätigung
    return Response.json({ ok: true, bookingId: result.bookingId, redirect: `/b/${encodeURIComponent(result.personalToken)}` });
  } catch (err) {
    return errorResponse(tenant, err);
  }
}
