import { z } from "zod";
import { appSettingsAuth } from "@/lib/app-settings";
import { enableMember, loadTeam, updateMember } from "@/lib/admin/members";
import { closeAccessRequest, listOpenAccessRequests } from "@/lib/access-requests";
import { toAdminError } from "@/lib/admin/errors";
import { adminErrorText } from "@/lib/texts/admin";
import { sendMailsSoon } from "@/lib/booking/api";
import type { AdminContext } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";
const noStore = { "cache-control": "no-store" };

const role = z.enum(["owner", "admin", "sales"]);
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("enable"), pipedriveUserId: z.number().int().positive(), role }),
  z.object({ action: z.literal("update"), userId: z.string().uuid(), role: role.optional(), status: z.enum(["active", "disabled"]).optional() }),
  z.object({ action: z.literal("decline"), pipedriveUserId: z.number().int().positive() }),
]);

async function snapshot(ctx: AdminContext) {
  const [team, requests] = await Promise.all([loadTeam(ctx), listOpenAccessRequests(ctx)]);
  return { team, requests, viewer: { role: ctx.role } };
}

/** Nutzerverwaltung in den Pipedrive-App-Einstellungen: aktueller Stand */
export async function GET() {
  const ctx = await appSettingsAuth();
  if (!ctx) return Response.json({ ok: false, error: "session" }, { status: 401, headers: noStore });
  return Response.json({ ok: true, ...(await snapshot(ctx)) }, { headers: noStore });
}

/** Freischalten, Rolle/Status ändern, Anfrage ablehnen – Rechte wie im Admin (RLS) */
export async function POST(req: Request) {
  const ctx = await appSettingsAuth();
  if (!ctx) return Response.json({ ok: false, error: "session" }, { status: 401, headers: noStore });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ ok: false, error: "invalid_input", message: adminErrorText("invalid_input") }, { status: 400, headers: noStore });
  const b = parsed.data;
  try {
    if (b.action === "enable") {
      await enableMember(ctx, b.pipedriveUserId, b.role);
      sendMailsSoon(ctx.tenant.id);
    } else if (b.action === "update") {
      await updateMember(ctx, b.userId, { role: b.role, status: b.status });
    } else {
      await closeAccessRequest(ctx, b.pipedriveUserId, false);
    }
  } catch (err) {
    const e = toAdminError(err);
    return Response.json({ ok: false, error: e.code, message: adminErrorText(e.code) }, { status: 400, headers: noStore });
  }
  return Response.json({ ok: true, ...(await snapshot(ctx)) }, { headers: noStore });
}
