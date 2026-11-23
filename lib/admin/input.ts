/** Eingaben des Admin-Backends (zod, an der Systemgrenze) */
import { z } from "zod";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const createSlotSchema = z
  .object({
    eventId: z.string().uuid(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    from: time,
    to: time,
    location: z
      .string()
      .trim()
      .max(200)
      .transform((v) => (v === "" ? null : v)),
    capacity: z.coerce.number().int().min(1).max(10000),
    open: z.boolean(),
  })
  .refine((v) => v.to > v.from, { path: ["to"], message: "Ende muss nach dem Beginn liegen" });
export type CreateSlotInput = z.infer<typeof createSlotSchema>;

export const capacitySchema = z.object({ slotId: z.string().uuid(), capacity: z.coerce.number().int().min(1).max(10000) });

export const memberRoleSchema = z.enum(["owner", "admin", "sales"]);

export const enableMemberSchema = z.object({
  pipedriveUserId: z.coerce.number().int().positive(),
  role: memberRoleSchema,
});

export const updateMemberSchema = z
  .object({
    userId: z.string().uuid(),
    role: memberRoleSchema.optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .refine((v) => v.role !== undefined || v.status !== undefined);

export const mailScopeSchema = z.enum(["user", "tenant"]);

/** SMTP-Postfach aus dem Formular */
export const smtpFormSchema = z.object({
  scope: mailScopeSchema,
  senderEmail: z.string().trim().toLowerCase().email().max(320),
  senderName: z
    .string()
    .trim()
    .max(200)
    .transform((v) => (v === "" ? null : v)),
  host: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9.-]+$/),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.enum(["tls", "starttls"]).transform((v) => v === "tls"),
  user: z.string().trim().min(1).max(320),
  pass: z.string().min(1).max(1000),
});

/** Smart-BCC-Adresse (leer = entfernen); DB prüft zusätzlich die Domain */
export const smartBccSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .transform((v) => (v === "" ? null : v))
  .refine((v) => v === null || /^[a-z0-9._+-]+@([a-z0-9-]+\.)*pipedrivemail\.com$/.test(v), {
    message: "Nur Adressen auf @pipedrivemail.com",
  });

/** Signatur für Einladungen (Klartext) */
export const signatureSchema = z.string().max(2000).transform((v) => v.replace(/\r\n/g, "\n"));

/** Neue Veranstaltung */
/** Veranstaltung samt erstem Termin (ein Formular, eine Transaktion) */
export const createEventSchema = z
  .object({
  title: z.string().trim().min(1).max(200),
  location: z
    .string()
    .trim()
    .max(200)
    .transform((v) => (v === "" ? null : v)),
  description: z
    .string()
    .trim()
    .max(2000)
    .transform((v) => (v === "" ? null : v)),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    from: time,
    to: time,
    capacity: z.coerce.number().int().min(1).max(10000),
  })
  .refine((v) => v.to > v.from, { path: ["to"], message: "Ende muss nach dem Beginn liegen" });
export type CreateEventInput = z.infer<typeof createEventSchema>;
