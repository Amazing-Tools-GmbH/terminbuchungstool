import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCurrentTenant } from "@/lib/tenant/current";
import { loadBookingContact, loadBookingGuests, loadGuestContext, loadInvitationContext } from "@/lib/booking/service";
import { runAnon } from "@/lib/booking/api";
import { createTranslator, resolveTexts } from "@/lib/texts";
import { formatSlot } from "@/lib/datetime";
import { googleCalendarUrl, outlookCalendarUrl } from "@/lib/calendar/links";
import { bookingUrl } from "@/lib/links";
import { TenantHeader } from "@/components/tenant/TenantHeader";
import { TenantFooter } from "@/components/tenant/TenantFooter";
import { BookingApp, type BookingDisplay, type SlotDisplay } from "@/components/booking/BookingApp";
import { GuestView } from "@/components/booking/GuestView";
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

  const contact = await loadBookingContact(runAnon, tenant.id, token);

  // Link eines weiteren Teilnehmers: nur Termin ansehen (kein Absagen über den Link)
  if (!ctx) {
    const guestCtx = await loadGuestContext(runAnon, tenant.id, token);
    if (guestCtx) {
      const g = guestCtx;
      const when = formatSlot(g.booking.starts_at, g.booking.ends_at, tenant.timezone);
      const calendar = {
        title: `${g.event.title} – ${tenant.name}`,
        start: new Date(g.booking.starts_at),
        end: new Date(g.booking.ends_at),
        location: g.booking.location,
        details: bookingUrl(tenant, token),
      };
      return (
        <>
          <TenantHeader tenant={tenant} />
          <GuestView
            texts={resolveTexts(tenant.anrede, tenant.textOverrides)}
            eventTitle={g.event.title}
            guestName={g.guest.name}
            booker={g.booker.organization_name ? `${g.booker.name} (${g.booker.organization_name})` : g.booker.name}
            state={g.booking.status === "cancelled" || g.guest.status === "cancelled" ? "ended" : "active"}
            when={{ ...when, location: g.booking.location }}
            contactName={contact?.name ?? null}
            googleUrl={googleCalendarUrl(calendar)}
            outlookUrl={outlookCalendarUrl(calendar)}
          />
          <TenantFooter tenant={tenant} t={t} />
        </>
      );
    }
  }

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
  // Tag je Termin in der Mandanten-Zeitzone (Tagesauswahl wie im Panel)
  const dayParts = (iso: string) => {
    const d = new Date(iso);
    const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("de-AT", { timeZone: tz, ...o }).format(d);
    return {
      dayKey: new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d),
      dayNum: part({ day: "numeric" }).replace(".", ""),
      monthShort: part({ month: "short" }),
    };
  };
  const slots: SlotDisplay[] = ctx.slots.map((s) => ({
    id: s.id,
    ...formatSlot(s.starts_at, s.ends_at, tz),
    ...dayParts(s.starts_at),
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
      guests: await loadBookingGuests(runAnon, tenant.id, token),
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
        event={{ title: ctx.event.title, intro: ctx.event.intro_text, showSeats: ctx.event.show_seats }}
        invitation={{ name: ctx.invitation.name, email: ctx.invitation.email }}
        slots={slots}
        booking={booking}
        bookingOpen={bookingOpen}
        closedReason={ctx.invitation.expired ? t("hero.expired") : t("hero.unavailable")}
        contactName={contact?.name ?? null}
      />
      <TenantFooter tenant={tenant} t={t} />
    </>
  );
}
