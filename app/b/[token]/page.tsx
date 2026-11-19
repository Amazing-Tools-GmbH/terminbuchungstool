import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCurrentTenant } from "@/lib/tenant/current";
import { loadInvitationContext } from "@/lib/booking/service";
import { runAnon } from "@/lib/booking/api";
import { createTranslator, resolveTexts } from "@/lib/texts";
import { formatDateTime, formatSlot } from "@/lib/datetime";
import { googleCalendarUrl, outlookCalendarUrl } from "@/lib/calendar/links";
import { bookingUrl } from "@/lib/links";
import { TenantHeader } from "@/components/tenant/TenantHeader";
import { TenantFooter } from "@/components/tenant/TenantFooter";
import { BookingApp, type BookingDisplay, type SlotDisplay } from "@/components/booking/BookingApp";
import styles from "@/components/booking/Booking.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  // Persönliche Links: nicht indexieren, keine Weitergabe im Referrer
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function BookingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const tenant = await getCurrentTenant();
  if (!tenant) notFound();

  const t = createTranslator(tenant.anrede, tenant.textOverrides);
  const ctx = await loadInvitationContext(runAnon, tenant.id, token);

  if (!ctx) {
    return (
      <>
        <TenantHeader tenant={tenant} />
        <main className={`tb-container ${styles.message}`}>
          <h1>{t("notFound.title")}</h1>
          <p>{t("notFound.text")}</p>
        </main>
        <TenantFooter tenant={tenant} t={t} />
      </>
    );
  }

  const tz = tenant.timezone;
  const slots: SlotDisplay[] = ctx.slots.map((s) => ({
    id: s.id,
    ...formatSlot(s.starts_at, s.ends_at, tz),
    location: s.location,
    capacity: s.capacity,
    booked: s.booked,
    free: s.free,
    ownSeats: s.own_seats,
    bookable: s.bookable,
  }));

  let booking: BookingDisplay | null = null;
  if (ctx.booking) {
    const b = ctx.booking;
    const when = formatSlot(b.starts_at, b.ends_at, tz);
    const calendar = {
      title: `${ctx.event.title} – ${tenant.name}`,
      start: new Date(b.starts_at),
      end: new Date(b.ends_at),
      location: b.location,
      details: bookingUrl(tenant, token),
    };
    booking = {
      slotId: b.slot_id,
      ...when,
      location: b.location,
      seats: b.seats,
      name: b.name,
      email: b.email,
      extraAttendees: b.extra_attendees,
      changeUntil: formatDateTime(b.change_until, tz),
      canChange: b.changeable && !ctx.invitation.expired,
      icsUrl: `/b/${encodeURIComponent(token)}/ics`,
      googleUrl: googleCalendarUrl(calendar),
      outlookUrl: outlookCalendarUrl(calendar),
    };
  }

  const bookingOpen = !ctx.invitation.expired && ctx.event.status === "published";

  return (
    <>
      <TenantHeader
        tenant={tenant}
        aside={
          <>
            {t("header.invited")} <strong>{ctx.invitation.name}</strong>
            {ctx.invitation.organization_name ? `, ${ctx.invitation.organization_name}` : ""}
          </>
        }
      />
      <BookingApp
        token={token}
        texts={resolveTexts(tenant.anrede, tenant.textOverrides)}
        event={{ title: ctx.event.title, intro: ctx.event.intro_text }}
        invitation={{ name: ctx.invitation.name, email: ctx.invitation.email }}
        slots={slots}
        booking={booking}
        bookingOpen={bookingOpen}
        closedReason={ctx.invitation.expired ? t("hero.expired") : t("hero.unavailable")}
      />
      <TenantFooter tenant={tenant} t={t} />
    </>
  );
}
