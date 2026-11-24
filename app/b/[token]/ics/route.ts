import { getCurrentTenant } from "@/lib/tenant/current";
import { loadGuestContext, loadInvitationContext } from "@/lib/booking/service";
import { runAnon } from "@/lib/booking/api";
import { bookingIcs } from "@/lib/booking/ics";
import { bookingUrl } from "@/lib/links";

/** .ics der aktuellen Buchung zu diesem Buchungslink bzw. Link eines weiteren Teilnehmers */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const tenant = await getCurrentTenant();
  if (!tenant) return new Response("Not found", { status: 404 });

  let ics: string | null = null;
  const ctx = await loadInvitationContext(runAnon, tenant.id, token);
  if (ctx?.booking) {
    ics = bookingIcs({
      tenantName: tenant.name,
      invitationId: ctx.invitation.id,
      title: ctx.event.title,
      start: new Date(ctx.booking.starts_at),
      end: new Date(ctx.booking.ends_at),
      location: ctx.booking.location,
      url: bookingUrl(tenant, token),
      // aktueller Stand: ersetzt einen älteren Eintrag im Kalender
      versionAt: new Date(),
    });
  } else if (!ctx) {
    const g = await loadGuestContext(runAnon, tenant.id, token);
    if (g && g.booking.status === "confirmed" && g.guest.status === "confirmed" && g.booking.invitation_id) {
      ics = bookingIcs({
        tenantName: tenant.name,
        invitationId: g.booking.invitation_id,
        guestEmail: g.guest.email,
        title: g.event.title,
        start: new Date(g.booking.starts_at),
        end: new Date(g.booking.ends_at),
        location: g.booking.location,
        url: bookingUrl(tenant, token),
        versionAt: new Date(),
      });
    }
  }
  if (!ics) return new Response("Not found", { status: 404 });
  return new Response(ics, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="termin-${tenant.slug}.ics"`,
      "cache-control": "private, no-store",
    },
  });
}
