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

export const capacitySchema = z.object({ slotId: z.string().uuid(), by: z.coerce.number().int().min(1).max(1000).default(1) });

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
