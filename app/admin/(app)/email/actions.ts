"use server";
/** E-Mail-Einstellungen: eigenes Postfach verbinden/testen/trennen, Signatur, Versandweg und Smart BCC (Server Actions) */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/admin";
import { toAdminError } from "@/lib/admin/errors";
import { mailScopeSchema, signatureSchema, smartBccSchema, smtpFormSchema } from "@/lib/admin/input";
import { connectDevMailbox, disconnectMailbox, requestTestMail, saveMailRoute, saveMySignature, saveSmartBcc, saveSmtpMailbox } from "@/lib/mail/connect";
import { MAIL_ROUTES } from "@/lib/mail/routing";
import { sendMailsSoon } from "@/lib/booking/api";
import { devToolsEnabled } from "@/lib/dev-tools";

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v : undefined;
};
const PAGE = "/admin/email";

function done(path: string, result: { ok?: string; error?: string }): never {
  revalidatePath(path);
  const q = new URLSearchParams(result.error ? { error: result.error } : { ok: result.ok ?? "saved" });
  redirect(`${path}?${q}`);
}

async function attempt(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return toAdminError(err).code;
  }
}

export async function saveSmtpAction(form: FormData) {
  const ctx = await requireAdmin();
  const parsed = smtpFormSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) done(PAGE, { error: "invalid_input" });
  const { scope, ...rest } = parsed.data;
  const error = await attempt(() => saveSmtpMailbox(ctx, scope, rest));
  if (!error) sendMailsSoon(ctx.tenant.id);
  done(PAGE, error ? { error } : { ok: "connected" });
}

export async function sendTestAction(form: FormData) {
  const ctx = await requireAdmin();
  const id = z.string().uuid().safeParse(str(form, "id"));
  const error = id.success ? await attempt(() => requestTestMail(ctx, id.data)) : "invalid_input";
  if (!error) sendMailsSoon(ctx.tenant.id);
  done(PAGE, error ? { error } : { ok: "test" });
}

export async function disconnectAction(form: FormData) {
  const ctx = await requireAdmin();
  const id = z.string().uuid().safeParse(str(form, "id"));
  const error = id.success ? await attempt(() => disconnectMailbox(ctx, id.data)) : "invalid_input";
  done(PAGE, error ? { error } : { ok: "disconnected" });
}

export async function saveMailRouteAction(form: FormData) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const parsed = z.enum(MAIL_ROUTES as [string, ...string[]]).safeParse(str(form, "mailRoute"));
  const error = parsed.success ? await attempt(() => saveMailRoute(ctx, parsed.data as (typeof MAIL_ROUTES)[number])) : "invalid_input";
  done(PAGE, error ? { error } : { ok: "mailRoute" });
}

export async function saveSmartBccAction(form: FormData) {
  const ctx = await requireAdmin(["owner", "admin"]);
  const parsed = smartBccSchema.safeParse(str(form, "smartBcc") ?? "");
  const error = parsed.success ? await attempt(() => saveSmartBcc(ctx, parsed.data)) : "invalid_input";
  done(PAGE, error ? { error } : { ok: "smartBcc" });
}

export async function devConnectAction(form: FormData) {
  if (!devToolsEnabled()) redirect("/admin");
  const ctx = await requireAdmin();
  const scope = mailScopeSchema.catch("user").parse(str(form, "scope"));
  const error = await attempt(() => connectDevMailbox(ctx, scope));
  if (!error) sendMailsSoon(ctx.tenant.id);
  done(PAGE, error ? { error } : { ok: "connected" });
}

export async function saveSignatureAction(form: FormData) {
  const ctx = await requireAdmin();
  const parsed = signatureSchema.safeParse(str(form, "signature") ?? "");
  const error = parsed.success ? await attempt(() => saveMySignature(ctx, parsed.data)) : "invalid_input";
  done(PAGE, error ? { error } : { ok: "signature" });
}
