import { hostCustomDomain, tenantForToken } from "@/lib/tenant/current";
import { cancelInputSchema } from "@/lib/booking/input";
import { cancelGuest } from "@/lib/booking/service";
import { errorResponse, runAnon, sendMailsSoon } from "@/lib/booking/api";

/** Ein weiterer Teilnehmer sagt über seinen eigenen Link nur für sich ab (bis zur Frist) */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const token = typeof body?.token === "string" ? body.token : "";
  const tenant = token ? await tenantForToken(token, await hostCustomDomain()) : null;
  if (!tenant) return Response.json({ ok: false, error: "tenant_not_found" }, { status: 404 });

  const parsed = cancelInputSchema.safeParse(body);
  if (!parsed.success) return Response.json({ ok: false, error: "invalid_input" }, { status: 400 });

  try {
    const result = await cancelGuest(runAnon, tenant, parsed.data.token);
    sendMailsSoon(tenant.id);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return errorResponse(tenant, err);
  }
}
