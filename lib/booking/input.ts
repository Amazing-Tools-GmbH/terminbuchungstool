import { z } from "zod";

/** Eingaben der Buchungs-API (Client -> Server). Die DB prüft zusätzlich. */
export const bookInputSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{20,200}$/),
  slotId: z.string().uuid(),
  seats: z.number().int().min(1).max(1000),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(254),
  extraAttendees: z.array(z.string().trim().max(200)).max(999).default([]),
});
export type BookInput = z.infer<typeof bookInputSchema>;

export const cancelInputSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{20,200}$/),
});

/** "Max Beispiel, Eva Probe" -> ["Max Beispiel", "Eva Probe"] */
export function splitAttendees(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
