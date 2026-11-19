import { hostCustomDomain, tenantForToken } from "@/lib/tenant/current";
import { bookInputSchema } from "@/lib/booking/input";
import { bookSlot } from "@/lib/booking/service";
import { errorResponse, runAnon, sendMailsSoon } from "@/lib/booking/api";
import { createTranslator } from "@/lib/texts";

/** Buchen bzw. Umbuchen über den persönlichen Buchungslink */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const token = typeof body?.token === "string" ? body.token : "";
  // Mandant aus dem Buchungslink (auf eigener Kundendomain muss er dazu passen)
  const tenant = token ? await tenantForToken(token, await hostCustomDomain()) : null;
  if (!tenant) return Response.json({ ok: false, error: "tenant_not_found" }, { status: 404 });

  const parsed = bookInputSchema.safeParse(body);
  if (!parsed.success) {
    const t = createTranslator(tenant.anrede, tenant.textOverrides);
    const field = parsed.error.issues[0]?.path[0];
    const message =
      field === "email" ? t("error.invalid_email") : field === "name" ? t("error.invalid_name") : t("error.generic");
    return Response.json({ ok: false, error: "invalid_input", field, message }, { status: 400 });
  }

  try {
    const result = await bookSlot(runAnon, tenant, parsed.data);
    sendMailsSoon(tenant.id);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return errorResponse(tenant, err);
  }
}
