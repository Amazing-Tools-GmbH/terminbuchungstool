import { withActor } from "@/lib/db";
import { devToolsEnabled } from "@/lib/dev-tools";
import type { MailMessage } from "@/lib/mail/types";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!devToolsEnabled()) return new Response("Not found", { status: 404 });
  const { id } = await params;
  const i = Number(new URL(req.url).searchParams.get("i") ?? 0);
  const mail = await withActor({ role: "service_role" }, async (c) => {
    const { rows } = await c.query<{ rendered: MailMessage | null }>("select rendered from public.email_outbox where id = $1", [id]);
    return rows[0]?.rendered ?? null;
  });
  const a = mail?.attachments?.[i];
  if (!a) return new Response("Not found", { status: 404 });
  return new Response(a.content, {
    headers: { "content-type": a.contentType, "content-disposition": `attachment; filename="${a.filename}"` },
  });
}
