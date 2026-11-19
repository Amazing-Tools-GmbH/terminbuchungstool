import { getCurrentTenant } from "@/lib/tenant/current";
import { loadInvitationContext } from "@/lib/booking/service";
import { runAnon } from "@/lib/booking/api";
import { bookingIcs } from "@/lib/booking/ics";
import { bookingUrl } from "@/lib/links";

/** .ics der aktuellen Buchung zu diesem Buchungslink */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const tenant = await getCurrentTenant();
  if (!tenant) return new Response("Not found", { status: 404 });
  const ctx = await loadInvitationContext(runAnon, tenant.id, token);
  if (!ctx?.booking) return new Response("Not found", { status: 404 });

  const ics = bookingIcs({
    tenantName: tenant.name,
    invitationId: ctx.invitation.id,
    title: ctx.event.title,
    start: new Date(ctx.booking.starts_at),
    end: new Date(ctx.booking.ends_at),
    location: ctx.booking.location,
    url: bookingUrl(tenant, token),
    versionAt: new Date(ctx.booking.created_at),
  });
  return new Response(ics, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="termin-${tenant.slug}.ics"`,
      "cache-control": "private, no-store",
    },
  });
}
