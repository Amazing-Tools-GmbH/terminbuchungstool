/**
 * Versand über das in Pipedrive verbundene Postfach eines Mitarbeiters
 * (OAuth-Token aus seinem Login, Scope mail-sending:full). Ablauf wie in
 * Pipedrive selbst: Entwurf anlegen (mit Deal verknüpft) -> senden. Pipedrive
 * legt die Mail im Deal-Verlauf ab und synchronisiert sie in "Gesendet".
 *
 * Zwei Wege (PIPEDRIVE_MAIL_TRANSPORT):
 *   mcp  (Standard) Pipedrives offizieller MCP-Server, Tools createMailDraft /
 *        sendMailDraft – so ging der Live-Test am 19.11.2026 raus.
 *   rest Pipedrive-API: POST /api/v1/mailbox/mailDrafts (Anlegen nachgewiesen),
 *        POST …/mailDrafts/{id}/send (Format noch nicht bestätigt).
 * Beide sind nicht in der API-Referenz dokumentiert; Details:
 * docs/research/pipedrive-mailversand.md.
 *
 * Fehler tragen einen Code für eine verständliche Meldung (kein stiller
 * Wechsel auf einen anderen Versandweg).
 */
import { MailSendError, type MailMessage, type MailSender, type SendResult } from "@/lib/mail/types";

type Fetch = typeof fetch;

export type PipedriveMailAccess = { apiDomain: string; accessToken: string };
export type DraftInput = { to: { email_address: string; name?: string }[]; subject: string; body: string; deal_id?: number };

export interface PipedriveMailTransport {
  createDraft(access: PipedriveMailAccess, input: DraftInput): Promise<{ id: number }>;
  sendDraft(access: PipedriveMailAccess, id: number): Promise<void>;
}

/** Gemeinsame Einordnung von Pipedrive-Fehlern -> Fehlerart + Code */
export function classifyPipedriveMailError(status: number | null, detail: string): MailSendError {
  const d = detail.toLowerCase();
  if (status === 401) return new MailSendError("auth", "Pipedrive-Anmeldung abgelaufen oder widerrufen", "pipedrive_reauth");
  if (status === 403 || /insufficient.?scope|scope|permission|forbidden/.test(d)) {
    return new MailSendError("auth", "Pipedrive erlaubt der App das Senden nicht (Scope mail-sending:full fehlt)", "pipedrive_no_permission");
  }
  if (/mailbox|mail ?account|no (connected )?account|not connected|connect (a|your) (mailbox|email)/.test(d)) {
    return new MailSendError("permanent", "In Pipedrive ist kein Postfach verbunden", "pipedrive_no_mailbox");
  }
  if (status === null || status === 429 || status >= 500) {
    return new MailSendError("transient", `Pipedrive vorübergehend nicht erreichbar${status ? ` (${status})` : ""}`, "pipedrive_unavailable");
  }
  return new MailSendError("permanent", `Pipedrive hat die Mail abgelehnt (${status}): ${detail.slice(0, 200)}`, "pipedrive_rejected");
}

// ---------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------

export class RestPipedriveMailTransport implements PipedriveMailTransport {
  constructor(private readonly f: Fetch = fetch) {}

  private async call(access: PipedriveMailAccess, path: string, body: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.f(`${access.apiDomain.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${access.accessToken}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw classifyPipedriveMailError(null, (err as Error).message);
    }
    const text = await res.text();
    if (!res.ok) throw classifyPipedriveMailError(res.status, text);
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  async createDraft(access: PipedriveMailAccess, input: DraftInput) {
    const r = (await this.call(access, "/api/v1/mailbox/mailDrafts", { ...input, sendmode: "new" })) as { data?: { id?: number } };
    const id = r.data?.id;
    if (typeof id !== "number") throw classifyPipedriveMailError(500, "Entwurf ohne ID");
    return { id };
  }

  async sendDraft(access: PipedriveMailAccess, id: number) {
    await this.call(access, `/api/v1/mailbox/mailDrafts/${id}/send`, {});
  }
}

// ---------------------------------------------------------------------
// MCP (Streamable HTTP, JSON-RPC 2.0)
// ---------------------------------------------------------------------

export const PIPEDRIVE_MCP_URL = "https://mcp.pipedrive.ai/mcp";
const MCP_PROTOCOL_VERSION = "2025-06-18";

type JsonRpcResponse = { id?: number; result?: unknown; error?: { code: number; message: string } };

/** Antwort als JSON oder als Server-Sent Events (data:-Zeilen) lesen */
export function parseMcpBody(contentType: string | null, text: string, id: number): JsonRpcResponse | null {
  const candidates: unknown[] = [];
  if (contentType?.includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        candidates.push(JSON.parse(line.slice(5).trim()));
      } catch {
        /* keine JSON-Zeile */
      }
    }
  } else if (text.trim()) {
    try {
      const j = JSON.parse(text);
      candidates.push(...(Array.isArray(j) ? j : [j]));
    } catch {
      return null;
    }
  }
  return (candidates.find((c) => (c as JsonRpcResponse)?.id === id) as JsonRpcResponse | undefined) ?? null;
}

type ToolResult = { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };

/** Inhalt eines Tool-Ergebnisses als Objekt (structuredContent oder JSON im Text) */
export function toolPayload(r: ToolResult): Record<string, unknown> {
  if (r.structuredContent && typeof r.structuredContent === "object") return r.structuredContent as Record<string, unknown>;
  const text = r.content?.find((c) => c.type === "text")?.text ?? "";
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { text };
  }
}

export class McpPipedriveMailTransport implements PipedriveMailTransport {
  constructor(
    private readonly f: Fetch = fetch,
    private readonly url = PIPEDRIVE_MCP_URL,
  ) {}

  private async session(access: PipedriveMailAccess) {
    let nextId = 1;
    let sessionId: string | null = null;
    const post = async (payload: Record<string, unknown>, expectId: number | null) => {
      let res: Response;
      try {
        res = await this.f(this.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${access.accessToken}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": MCP_PROTOCOL_VERSION,
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", ...payload }),
        });
      } catch (err) {
        throw classifyPipedriveMailError(null, (err as Error).message);
      }
      sessionId = res.headers.get("mcp-session-id") ?? sessionId;
      const text = await res.text();
      if (!res.ok) throw classifyPipedriveMailError(res.status, text);
      if (expectId === null) return null;
      const msg = parseMcpBody(res.headers.get("content-type"), text, expectId);
      if (!msg) throw classifyPipedriveMailError(502, "Unerwartete Antwort des Pipedrive-MCP-Servers");
      if (msg.error) throw classifyPipedriveMailError(400, msg.error.message);
      return msg.result;
    };
    const init = nextId++;
    await post(
      {
        id: init,
        method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "terminbuchungstool", version: "1.0" } },
      },
      init,
    );
    await post({ method: "notifications/initialized" }, null);
    return async (name: string, args: Record<string, unknown>) => {
      const id = nextId++;
      const result = (await post({ id, method: "tools/call", params: { name, arguments: args } }, id)) as ToolResult;
      const payload = toolPayload(result ?? {});
      if (result?.isError) throw classifyPipedriveMailError(400, JSON.stringify(payload));
      return payload;
    };
  }

  // Ein Entwurf und sein Versand laufen in derselben MCP-Sitzung (siehe sendMessage)
  private callTool: ((name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>) | null = null;

  async createDraft(access: PipedriveMailAccess, input: DraftInput) {
    this.callTool = await this.session(access);
    const r = await this.callTool("createMailDraft", { sendmode: "new", ...input });
    const id = typeof r.id === "number" ? r.id : Number(r.id);
    if (!Number.isFinite(id)) throw classifyPipedriveMailError(502, "Entwurf ohne ID");
    return { id };
  }

  async sendDraft(access: PipedriveMailAccess, id: number) {
    const call = this.callTool ?? (await this.session(access));
    await call("sendMailDraft", { id });
  }
}

// ---------------------------------------------------------------------
// MailSender
// ---------------------------------------------------------------------

/** Text der Mail für Pipedrive: nur HTML-Body (Pipedrive bettet ihn selbst ein) */
function bodyHtml(m: MailMessage): string {
  const match = /<body[^>]*>([\s\S]*)<\/body>/i.exec(m.html);
  return match ? match[1]!.trim() : m.html;
}

export class PipedriveMailSender implements MailSender {
  constructor(
    private readonly access: () => Promise<PipedriveMailAccess>,
    private readonly transport: PipedriveMailTransport,
  ) {}

  async send(m: MailMessage): Promise<SendResult> {
    if (m.attachments?.length) {
      // Über Pipedrive gehen keine Anhänge – Einladungen brauchen keine
      throw new MailSendError("permanent", "Anhänge werden beim Versand über Pipedrive nicht unterstützt", "pipedrive_rejected");
    }
    const access = await this.access();
    const draft = await this.transport.createDraft(access, {
      to: [{ email_address: m.to.email, ...(m.to.name ? { name: m.to.name } : {}) }],
      subject: m.subject,
      body: bodyHtml(m),
      ...(m.pipedriveDealId ? { deal_id: m.pipedriveDealId } : {}),
    });
    await this.transport.sendDraft(access, draft.id);
    return { messageId: `pipedrive-draft-${draft.id}` };
  }
}
