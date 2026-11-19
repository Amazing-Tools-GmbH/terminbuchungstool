/**
 * Postfach verbinden: OAuth (Google/Microsoft), Versand über Gmail API und
 * Microsoft Graph (mit simulierten Antworten), MIME mit BCC, Absenderwahl,
 * Eingaben.
 */
import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  connectMailbox,
  GOOGLE_SEND_SCOPE,
  mailAuthorizeUrl,
  mailOAuthConfig,
  MailConnectError,
  refreshMailTokens,
  type OAuthCredentials,
} from "@/lib/mail/oauth";
import { GoogleMailSender, GMAIL_SEND_URL } from "@/lib/mail/senders/google";
import { graphMessage, MicrosoftMailSender, GRAPH_SEND_URL } from "@/lib/mail/senders/microsoft";
import { classifyHttp } from "@/lib/mail/senders/oauth-token";
import { buildMime } from "@/lib/mail/mime";
import { routeMail, type RouteConnection } from "@/lib/mail/routing";
import { inviteMailProvider, oauthProvidersVisible, systemMailConfig, pipedriveMailTransport } from "@/lib/mail/config";
import {
  classifyPipedriveMailError,
  McpPipedriveMailTransport,
  parseMcpBody,
  PipedriveMailSender,
  RestPipedriveMailTransport,
  PIPEDRIVE_MCP_URL,
  type PipedriveMailTransport,
} from "@/lib/pipedrive/mail";
import { canSendMail } from "@/lib/pipedrive/scopes";
import { MailSendError, type MailMessage } from "@/lib/mail/types";
import { smartBccSchema, smtpFormSchema } from "@/lib/admin/input";
import { mailStateSchema, seal, unseal } from "@/lib/auth/session";

const cfg = { clientId: "cid", clientSecret: "secret", redirectUri: "https://app.example/api/mail/oauth/google/callback" };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const idToken = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

type Call = { url: string; init?: RequestInit };
function fakeFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as unknown as typeof fetch;
  return { f, calls };
}

const message: MailMessage = {
  from: { email: "markus@firma.example", name: "Markus Fink" },
  to: { email: "eva@kunde.example", name: "Eva Probe" },
  replyTo: { email: "termine@firma.example", name: "Firma" },
  bcc: [{ email: "firma@pipedrivemail.com" }],
  subject: "Buchungsbestätigung: Workshop",
  html: "<p>Hallo Eva</p>",
  text: "Hallo Eva",
  attachments: [{ filename: "termin.ics", contentType: "text/calendar; charset=utf-8", content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR" }],
};

describe("OAuth-Konfiguration und Anmelde-URL", () => {
  it("nur mit Client-ID/Secret; Callback je Anbieter unter APP_BASE_URL", () => {
    expect(mailOAuthConfig("google", {})).toBeNull();
    expect(mailOAuthConfig("microsoft", { MICROSOFT_CLIENT_ID: "a", MICROSOFT_CLIENT_SECRET: "b", APP_BASE_URL: "https://app.example/" })).toEqual({
      clientId: "a",
      clientSecret: "b",
      redirectUri: "https://app.example/api/mail/oauth/microsoft/callback",
    });
  });

  it("Google: nur Senden, Offline-Zugang, Zustimmung erzwingen", () => {
    const u = new URL(mailAuthorizeUrl("google", cfg, "S", "markus@firma.example"));
    expect(u.origin).toBe("https://accounts.google.com");
    expect(u.searchParams.get("scope")?.split(" ")).toEqual(["openid", "email", GOOGLE_SEND_SCOPE]);
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("login_hint")).toBe("markus@firma.example");
    expect(u.searchParams.get("scope")).not.toMatch(/gmail\.(readonly|modify)|mail\.google\.com/);
  });

  it("Microsoft: Mail.Send + offline_access über /common", () => {
    const u = new URL(mailAuthorizeUrl("microsoft", cfg, "S"));
    expect(u.pathname).toBe("/common/oauth2/v2.0/authorize");
    expect(u.searchParams.get("scope")).toContain("https://graph.microsoft.com/Mail.Send");
    expect(u.searchParams.get("scope")).toContain("offline_access");
    expect(u.searchParams.get("scope")).not.toMatch(/Mail\.Read/);
  });
});

describe("Postfach verbinden (Code einlösen)", () => {
  it("Google: Adresse aus dem ID-Token, Refresh-Token gespeichert", async () => {
    const { f, calls } = fakeFetch(() =>
      json(200, {
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3599,
        scope: `openid ${GOOGLE_SEND_SCOPE} email`,
        id_token: idToken({ email: "Markus@Firma.example", email_verified: true, name: "Markus Fink" }),
      }),
    );
    const mb = await connectMailbox("google", cfg, "CODE", f);
    expect(mb).toMatchObject({ email: "markus@firma.example", name: "Markus Fink", credentials: { kind: "oauth", refreshToken: "rt", accessToken: "at" } });
    expect(String(calls[0]!.init!.body)).toContain("grant_type=authorization_code");
    expect(String(calls[0]!.init!.body)).toContain("client_secret=secret");
  });

  it("Google: ohne gmail.send-Recht (abgewählt) -> scope_missing", async () => {
    const { f } = fakeFetch(() => json(200, { access_token: "at", refresh_token: "rt", expires_in: 3599, scope: "openid email", id_token: idToken({ email: "a@b.example" }) }));
    await expect(connectMailbox("google", cfg, "CODE", f)).rejects.toMatchObject({ code: "scope_missing" });
  });

  it("ohne Refresh-Token -> no_refresh_token; abgelehnter Code -> oauth_failed", async () => {
    const noRt = fakeFetch(() => json(200, { access_token: "at", expires_in: 3599, scope: GOOGLE_SEND_SCOPE }));
    await expect(connectMailbox("google", cfg, "CODE", noRt.f)).rejects.toMatchObject({ code: "no_refresh_token" });
    const bad = fakeFetch(() => json(400, { error: "invalid_grant" }));
    await expect(connectMailbox("google", cfg, "CODE", bad.f)).rejects.toBeInstanceOf(MailConnectError);
  });

  it("Microsoft: Adresse über Graph /me (mail, sonst userPrincipalName)", async () => {
    const { f, calls } = fakeFetch((url) =>
      url.startsWith("https://graph.microsoft.com/")
        ? json(200, { displayName: "Markus Fink", mail: null, userPrincipalName: "Markus@Firma.onmicrosoft.com" })
        : json(200, { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "Mail.Send User.Read" }),
    );
    const mb = await connectMailbox("microsoft", { ...cfg, redirectUri: "https://app.example/api/mail/oauth/microsoft/callback" }, "CODE", f);
    expect(mb.email).toBe("markus@firma.onmicrosoft.com");
    expect((calls[1]!.init!.headers as Record<string, string>).authorization).toBe("Bearer at");
  });

  it("Token-Refresh: invalid_grant -> Anmeldefehler (Postfach neu verbinden)", async () => {
    const { f } = fakeFetch(() => json(400, { error: "invalid_grant" }));
    await expect(refreshMailTokens("google", cfg, "rt", f)).rejects.toMatchObject({ kind: "auth" });
    const down = fakeFetch(() => json(503, {}));
    await expect(refreshMailTokens("google", cfg, "rt", down.f)).rejects.toMatchObject({ kind: "transient" });
  });
});

describe("MIME", () => {
  it("enthält Bcc-Kopfzeile (Gmail entfernt sie beim Senden), Reply-To und .ics-Anhang", async () => {
    const mime = (await buildMime(message)).toString("utf8");
    expect(mime).toMatch(/^Bcc: firma@pipedrivemail\.com/m);
    expect(mime).toMatch(/^Reply-To: Firma <termine@firma\.example>/m);
    expect(mime).toContain('filename=termin.ics');
    expect(mime).toMatch(/Content-Type: text\/calendar/);
  });
});

const fresh = (): OAuthCredentials => ({ kind: "oauth", refreshToken: "rt", accessToken: "at-old", expiresAt: new Date(Date.now() + 3600_000).toISOString() });

describe("Versand über Gmail API", () => {
  it("sendet RFC-822 (base64url) mit gültigem Token, liefert Message-ID", async () => {
    const { f, calls } = fakeFetch(() => json(200, { id: "gmail-1" }));
    const r = await new GoogleMailSender({ config: cfg, credentials: fresh(), fetch: f }).send(message);
    expect(r.messageId).toBe("gmail-1");
    expect(calls[0]!.url).toBe(GMAIL_SEND_URL);
    const raw = Buffer.from(JSON.parse(String(calls[0]!.init!.body)).raw, "base64url").toString("utf8");
    expect(raw).toContain("Bcc: firma@pipedrivemail.com");
    expect(raw).toContain("Subject: =?UTF-8?Q?Buchungsbest");
  });

  it("abgelaufenes Token: erst Refresh, neue Zugangsdaten werden gespeichert", async () => {
    const saved: OAuthCredentials[] = [];
    const { f, calls } = fakeFetch((url) => (url.includes("oauth2.googleapis.com/token") ? json(200, { access_token: "at-new", expires_in: 3600 }) : json(200, { id: "g2" })));
    await new GoogleMailSender({
      config: cfg,
      credentials: { kind: "oauth", refreshToken: "rt" },
      fetch: f,
      onCredentials: async (c) => void saved.push(c),
    }).send(message);
    expect(calls.map((c) => c.url)).toEqual(["https://oauth2.googleapis.com/token", GMAIL_SEND_URL]);
    expect(saved[0]).toMatchObject({ refreshToken: "rt", accessToken: "at-new" });
    expect((calls[1]!.init!.headers as Record<string, string>).authorization).toBe("Bearer at-new");
  });

  it("401 trotz Cache: einmal neu holen und erneut senden", async () => {
    let n = 0;
    const { f } = fakeFetch((url) => {
      if (url.includes("/token")) return json(200, { access_token: "at-2", expires_in: 3600 });
      return ++n === 1 ? json(401, {}) : json(200, { id: "ok" });
    });
    expect((await new GoogleMailSender({ config: cfg, credentials: fresh(), fetch: f }).send(message)).messageId).toBe("ok");
  });

  it("Fehlerarten: 403 Recht entzogen -> auth, 403 Ratenlimit/429/5xx -> transient, 400 -> permanent", () => {
    expect(classifyHttp(403, "insufficientPermissions").kind).toBe("auth");
    expect(classifyHttp(403, '{"reason":"rateLimitExceeded"}').kind).toBe("transient");
    expect(classifyHttp(403, "Daily user sending limit exceeded").kind).toBe("transient");
    expect(classifyHttp(429, "").kind).toBe("transient");
    expect(classifyHttp(503, "").kind).toBe("transient");
    expect(classifyHttp(400, "invalid to").kind).toBe("permanent");
  });

  it("ohne OAuth-Konfiguration und abgelaufenem Token: vorübergehender Fehler (Mail wartet)", async () => {
    const { f } = fakeFetch(() => json(200, {}));
    await expect(new GoogleMailSender({ config: null, credentials: { kind: "oauth", refreshToken: "rt" }, fetch: f }).send(message)).rejects.toMatchObject({
      kind: "transient",
    });
  });
});

describe("Versand über Microsoft Graph", () => {
  it("Nutzlast: HTML, Empfänger, BCC, Reply-To, .ics als Datei-Anhang, in Gesendete Elemente", () => {
    const g = graphMessage(message);
    expect(g.saveToSentItems).toBe(true);
    expect(g.message.toRecipients).toEqual([{ emailAddress: { address: "eva@kunde.example", name: "Eva Probe" } }]);
    expect(g.message.bccRecipients).toEqual([{ emailAddress: { address: "firma@pipedrivemail.com" } }]);
    expect(g.message.replyTo).toEqual([{ emailAddress: { address: "termine@firma.example", name: "Firma" } }]);
    expect(g.message.attachments[0]).toMatchObject({ "@odata.type": "#microsoft.graph.fileAttachment", name: "termin.ics" });
    expect(Buffer.from(g.message.attachments[0]!.contentBytes, "base64").toString()).toContain("BEGIN:VCALENDAR");
  });

  it("202 = gesendet; rotiertes Refresh-Token wird gespeichert", async () => {
    const saved: OAuthCredentials[] = [];
    const { f, calls } = fakeFetch((url) =>
      url.includes("/token") ? json(200, { access_token: "at", refresh_token: "rt-neu", expires_in: 3600 }) : new Response(null, { status: 202 }),
    );
    const r = await new MicrosoftMailSender({
      config: cfg,
      credentials: { kind: "oauth", refreshToken: "rt" },
      fetch: f,
      onCredentials: async (c) => void saved.push(c),
    }).send(message);
    expect(r.messageId).toBeNull();
    expect(calls[1]!.url).toBe(GRAPH_SEND_URL);
    expect(saved[0]!.refreshToken).toBe("rt-neu");
  });

  it("Netzwerkfehler -> transient", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(new MicrosoftMailSender({ config: cfg, credentials: fresh(), fetch: f }).send(message)).rejects.toBeInstanceOf(MailSendError);
  });
});

describe("Versandweg", () => {
  const c = (id: string, status: RouteConnection["status"]): RouteConnection => ({ id, status, senderEmail: `${id}@firma.example` });
  const inviter = { userId: "u1", name: "Markus Fink", email: "markus@firma.example", active: true };

  it("Bestätigung/Stornierung immer System, Reply-To = Einladender", () => {
    for (const mode of ["pipedrive", "oauth", "smtp"] as const) {
      expect(routeMail("confirmation", mode, { inviter, userConnection: c("x", "error") })).toEqual({
        kind: "system",
        channel: "system",
        fromName: null,
        replyTo: { email: "markus@firma.example", name: "Markus Fink" },
      });
    }
    expect(routeMail("cancellation", "pipedrive", { inviter: { ...inviter, active: false }, userConnection: null })).toMatchObject({ kind: "system", replyTo: null });
  });

  it("Einladung je Einstellung; Fehler statt stillem Wechsel", () => {
    expect(routeMail("invitation", "pipedrive", { inviter, userConnection: null })).toEqual({ kind: "pipedrive", channel: "pipedrive", userId: "u1" });
    expect(routeMail("invitation", "oauth", { inviter, userConnection: c("m", "active") })).toMatchObject({ kind: "connection", connection: { id: "m" } });
    expect(routeMail("invitation", "oauth", { inviter, userConnection: null })).toMatchObject({ kind: "error", code: "no_user_mailbox" });
    expect(routeMail("invitation", "oauth", { inviter, userConnection: c("m", "pending") })).toMatchObject({ kind: "error", code: "user_mailbox_error" });
    expect(routeMail("invitation", "smtp", { inviter, userConnection: null })).toEqual({
      kind: "system",
      channel: "smtp",
      fromName: "Markus Fink",
      replyTo: { email: "markus@firma.example", name: "Markus Fink" },
    });
    expect(routeMail("invitation", "pipedrive", { inviter: null, userConnection: null })).toMatchObject({ kind: "error", code: "no_inviter" });
  });
});

describe("Konfiguration", () => {
  it("INVITE_MAIL_PROVIDER: Standard pipedrive, ungültig -> Fehler", () => {
    expect(inviteMailProvider({})).toBe("pipedrive");
    expect(inviteMailProvider({ INVITE_MAIL_PROVIDER: "smtp" })).toBe("smtp");
    expect(() => inviteMailProvider({ INVITE_MAIL_PROVIDER: "gmail" })).toThrow(/INVITE_MAIL_PROVIDER/);
  });

  it("Google/Microsoft-Buttons nur bei oauth UND eingetragenen Zugangsdaten", () => {
    const creds = { GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s", MICROSOFT_CLIENT_ID: "m", MICROSOFT_CLIENT_SECRET: "s" };
    expect(oauthProvidersVisible(creds)).toEqual({ google: false, microsoft: false }); // Standard pipedrive
    expect(oauthProvidersVisible({ ...creds, INVITE_MAIL_PROVIDER: "oauth" })).toEqual({ google: true, microsoft: true });
    expect(oauthProvidersVisible({ INVITE_MAIL_PROVIDER: "oauth", GOOGLE_CLIENT_ID: "g" })).toEqual({ google: false, microsoft: false });
  });

  it("System-Absender: SMTP vollständig oder dev (nie in Produktion), sonst null", () => {
    expect(systemMailConfig({})).toBeNull();
    expect(systemMailConfig({ SYSTEM_MAIL_FROM: "termine@firma.example", SYSTEM_MAIL_TRANSPORT: "dev" })).toMatchObject({ transport: "dev" });
    expect(systemMailConfig({ SYSTEM_MAIL_FROM: "termine@firma.example", SYSTEM_MAIL_TRANSPORT: "dev", NODE_ENV: "production" })).toBeNull();
    expect(systemMailConfig({ SYSTEM_MAIL_FROM: "termine@firma.example", SYSTEM_SMTP_HOST: "smtp.firma.example" })).toBeNull(); // Benutzer/Passwort fehlen
    expect(
      systemMailConfig({
        SYSTEM_MAIL_FROM: "Termine@Firma.example",
        SYSTEM_MAIL_FROM_NAME: "Firma Termine",
        SYSTEM_SMTP_HOST: "smtp.firma.example",
        SYSTEM_SMTP_PORT: "465",
        SYSTEM_SMTP_SECURE: "true",
        SYSTEM_SMTP_USER: "u",
        SYSTEM_SMTP_PASS: "p",
      }),
    ).toEqual({ transport: "smtp", fromEmail: "termine@firma.example", fromName: "Firma Termine", smtp: { host: "smtp.firma.example", port: 465, secure: true, user: "u", pass: "p" } });
  });

  it("Pipedrive-Versandweg: Standard mcp", () => {
    expect(pipedriveMailTransport({})).toBe("mcp");
    expect(pipedriveMailTransport({ PIPEDRIVE_MAIL_TRANSPORT: "rest" })).toBe("rest");
  });

  it("Senderecht am Scope erkennbar (Leerzeichen oder Komma)", () => {
    expect(canSendMail("base,deals:full,mail-sending:full")).toBe(true);
    expect(canSendMail("base mail:full")).toBe(false);
    expect(canSendMail(null)).toBe(false);
  });
});

describe("Versand über Pipedrive", () => {
  const access = { apiDomain: "https://firma.pipedrive.com", accessToken: "tok" };
  const invitation: MailMessage = { ...message, bcc: undefined, attachments: [], pipedriveDealId: 501, html: "<html><body><p>Hallo</p></body></html>" };

  it("Fehler -> verständliche Codes", () => {
    expect(classifyPipedriveMailError(401, "")).toMatchObject({ kind: "auth", code: "pipedrive_reauth" });
    expect(classifyPipedriveMailError(403, "")).toMatchObject({ kind: "auth", code: "pipedrive_no_permission" });
    expect(classifyPipedriveMailError(400, "insufficient scope")).toMatchObject({ code: "pipedrive_no_permission" });
    expect(classifyPipedriveMailError(400, "Sending failed: user has no connected mailbox")).toMatchObject({ kind: "permanent", code: "pipedrive_no_mailbox" });
    expect(classifyPipedriveMailError(503, "")).toMatchObject({ kind: "transient", code: "pipedrive_unavailable" });
    expect(classifyPipedriveMailError(null, "fetch failed")).toMatchObject({ kind: "transient" });
    expect(classifyPipedriveMailError(400, "bad")).toMatchObject({ kind: "permanent", code: "pipedrive_rejected" });
  });

  it("Sender: Entwurf (nur HTML-Body, mit Deal) anlegen, dann senden; keine Anhänge", async () => {
    const calls: string[] = [];
    let draft: unknown;
    const t: PipedriveMailTransport = {
      createDraft: async (_a, input) => {
        calls.push("create");
        draft = input;
        return { id: 77 };
      },
      sendDraft: async (_a, id) => void calls.push(`send:${id}`),
    };
    const r = await new PipedriveMailSender(async () => access, t).send(invitation);
    expect(calls).toEqual(["create", "send:77"]);
    expect(draft).toEqual({ to: [{ email_address: "eva@kunde.example", name: "Eva Probe" }], subject: invitation.subject, body: "<p>Hallo</p>", deal_id: 501 });
    expect(r.messageId).toBe("pipedrive-draft-77");
    await expect(new PipedriveMailSender(async () => access, t).send(message)).rejects.toMatchObject({ code: "pipedrive_rejected" });
  });

  it("REST: POST /api/v1/mailbox/mailDrafts mit Bearer-Token, danach …/send", async () => {
    const { f, calls } = fakeFetch((url) => (url.endsWith("/mailDrafts") ? json(200, { success: true, data: { id: 2251 } }) : json(200, { success: true })));
    const t = new RestPipedriveMailTransport(f);
    expect(await t.createDraft(access, { to: [{ email_address: "eva@kunde.example" }], subject: "S", body: "<p>x</p>", deal_id: 501 })).toEqual({ id: 2251 });
    await t.sendDraft(access, 2251);
    expect(calls.map((c) => c.url)).toEqual([
      "https://firma.pipedrive.com/api/v1/mailbox/mailDrafts",
      "https://firma.pipedrive.com/api/v1/mailbox/mailDrafts/2251/send",
    ]);
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ sendmode: "new", deal_id: 501 });
  });

  it("MCP: initialize -> createMailDraft -> sendMailDraft in einer Sitzung (JSON und SSE)", async () => {
    const methods: string[] = [];
    const sessions: (string | undefined)[] = [];
    const { f } = fakeFetch((_url, init) => {
      const body = JSON.parse(String(init!.body));
      methods.push(body.params?.name ?? body.method);
      sessions.push((init!.headers as Record<string, string>)["mcp-session-id"]);
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }), {
          headers: { "content-type": "application/json", "mcp-session-id": "S1" },
        });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result =
        body.params.name === "createMailDraft"
          ? { content: [{ type: "text", text: JSON.stringify({ id: 2252, draft_flag: 1 }) }] }
          : { content: [{ type: "text", text: JSON.stringify({ id: 2252, in_queue: true }) }] };
      // SSE-Antwort wie bei Streamable HTTP
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const t = new McpPipedriveMailTransport(f);
    const { id } = await t.createDraft(access, { to: [{ email_address: "eva@kunde.example" }], subject: "S", body: "<p>x</p>", deal_id: 501 });
    await t.sendDraft(access, id);
    expect(id).toBe(2252);
    expect(methods).toEqual(["initialize", "notifications/initialized", "createMailDraft", "sendMailDraft"]);
    expect(sessions).toEqual([undefined, "S1", "S1", "S1"]);
  });

  it("MCP: Tool-Fehler (kein Postfach) -> Code pipedrive_no_mailbox", async () => {
    const { f } = fakeFetch((_u, init) => {
      const body = JSON.parse(String(init!.body));
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result = body.method === "initialize" ? {} : { isError: true, content: [{ type: "text", text: "Sending fails: the user has no connected mailbox" }] };
      return json(200, { jsonrpc: "2.0", id: body.id, result });
    });
    await expect(new McpPipedriveMailTransport(f).createDraft(access, { to: [], subject: "", body: "" })).rejects.toMatchObject({ code: "pipedrive_no_mailbox" });
  });

  it("MCP-Antwort lesen: passende ID aus JSON bzw. SSE", () => {
    expect(parseMcpBody("application/json", JSON.stringify({ id: 2, result: { ok: 1 } }), 2)).toEqual({ id: 2, result: { ok: 1 } });
    expect(parseMcpBody("text/event-stream", `data: {"id":1}\n\ndata: {"id":3,"result":7}\n`, 3)).toEqual({ id: 3, result: 7 });
    expect(parseMcpBody("application/json", "kein json", 1)).toBeNull();
    expect(PIPEDRIVE_MCP_URL).toBe("https://mcp.pipedrive.ai/mcp");
  });
});

describe("Eingaben", () => {
  it("SMTP-Formular", () => {
    const base = { scope: "user", senderEmail: " Markus@Firma.example ", senderName: "", host: "SMTP.Firma.example", port: "587", secure: "starttls", user: "markus", pass: "geheim" };
    expect(smtpFormSchema.parse(base)).toMatchObject({ senderEmail: "markus@firma.example", senderName: null, host: "smtp.firma.example", port: 587, secure: false });
    expect(smtpFormSchema.parse({ ...base, secure: "tls" }).secure).toBe(true);
    expect(smtpFormSchema.safeParse({ ...base, host: "smtp.firma.example; rm -rf" }).success).toBe(false);
    expect(smtpFormSchema.safeParse({ ...base, scope: "fremd" }).success).toBe(false);
  });

  it("Smart BCC nur @pipedrivemail.com, leer = entfernen", () => {
    expect(smartBccSchema.parse(" Firma@PipedriveMail.com ")).toBe("firma@pipedrivemail.com");
    expect(smartBccSchema.parse("")).toBeNull();
    expect(smartBccSchema.safeParse("mitlesen@evil.example").success).toBe(false);
    expect(smartBccSchema.safeParse("x@pipedrivemail.com.evil.example").success).toBe(false);
  });

  it("OAuth-state für Postfächer ist nicht als Login-State verwendbar", () => {
    const key = randomBytes(32).toString("base64");
    const v = { purpose: "mail", provider: "google", scope: "user", tid: "11111111-1111-4111-8111-111111111111", uid: "22222222-2222-4222-8222-222222222222", nonce: "n".repeat(20) };
    const s = seal("mail-state", v, 60, { key });
    expect(unseal("mail-state", s, mailStateSchema, { key })).toEqual(v);
    expect(unseal("login-state", s, mailStateSchema, { key })).toBeNull();
  });
});
