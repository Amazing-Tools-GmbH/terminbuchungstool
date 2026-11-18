import { getCurrentTenant } from "@/lib/tenant/current";
import { cancelInputSchema } from "@/lib/booking/input";
import { cancelBooking } from "@/lib/booking/service";
import { errorResponse, runAnon, sendMailsSoon } from "@/lib/booking/api";

/** Stornieren durch den Kunden (bis zur Frist) */
export async function POST(req: Request) {
  const tenant = await getCurrentTenant();
  if (!tenant) return Response.json({ ok: false, error: "tenant_not_found" }, { status: 404 });

  const parsed = cancelInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ ok: false, error: "invalid_input" }, { status: 400 });

  try {
    const result = await cancelBooking(runAnon, tenant, parsed.data.token);
    sendMailsSoon(tenant.id);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return errorResponse(tenant, err);
  }
}
