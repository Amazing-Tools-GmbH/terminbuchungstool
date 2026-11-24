/** Typisierung des Ergebnisses von public.get_invitation_context */
import { z } from "zod";

const ts = z.string().or(z.date()).transform((v) => new Date(v).toISOString());

export const slotSchema = z.object({
  id: z.string().uuid(),
  starts_at: ts,
  ends_at: ts,
  capacity: z.number().int(),
  booked: z.number().int(),
  free: z.number().int(),
  own_seats: z.number().int(),
  location: z.string().nullable(),
  status: z.enum(["open", "closed", "cancelled"]),
  bookable: z.boolean(),
});

export const invitationContextSchema = z.object({
  invitation: z.object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string(),
    organization_name: z.string().nullable(),
    status: z.enum(["open", "booked", "cancelled", "revoked"]),
    expires_at: ts,
    expired: z.boolean(),
  }),
  event: z.object({
    id: z.string().uuid(),
    title: z.string(),
    description: z.string().nullable(),
    intro_text: z.string().nullable(),
    location: z.string().nullable(),
    status: z.enum(["draft", "published", "archived"]),
  }),
  slots: z.array(slotSchema),
  booking: z
    .object({
      id: z.string().uuid(),
      slot_id: z.string().uuid(),
      starts_at: ts,
      ends_at: ts,
      location: z.string().nullable(),
      seats: z.number().int(),
      name: z.string(),
      email: z.string(),
      extra_attendees: z.array(z.string()),
      created_at: ts,
      change_until: ts,
      changeable: z.boolean(),
    })
    .nullable(),
});

export type InvitationContext = z.infer<typeof invitationContextSchema>;
export type SlotView = z.infer<typeof slotSchema>;
export type BookingView = NonNullable<InvitationContext["booking"]>;

/** Ergebnis von public.get_guest_context (Link eines weiteren Teilnehmers) */
export const guestContextSchema = z.object({
  guest: z.object({ name: z.string(), email: z.string(), status: z.enum(["confirmed", "cancelled"]) }),
  booker: z.object({ name: z.string(), organization_name: z.string().nullable() }),
  event: z.object({ title: z.string() }),
  booking: z.object({
    status: z.enum(["confirmed", "cancelled"]),
    invitation_id: z.string().uuid().optional(),
    starts_at: ts,
    ends_at: ts,
    location: z.string().nullable(),
    change_until: ts,
    changeable: z.boolean(),
  }),
});
export type GuestContext = z.infer<typeof guestContextSchema>;
