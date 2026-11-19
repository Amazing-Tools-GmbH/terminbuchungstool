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
import { chooseSender, type ChoiceConnection } from "@/lib/mail/sender-choice";
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

describe("Absenderwahl", () => {
  const c = (id: string, status: ChoiceConnection["status"]): ChoiceConnection => ({ id, status, senderEmail: `${id}@firma.example` });

  it.each([
    // [Typ, Mitarbeiter, Firma, erwartet, Fallback-Vermerk?]
    ["confirmation", c("u", "active"), c("t", "active"), "u", false],
    ["confirmation", null, c("t", "active"), "t", false],
    ["confirmation", c("u", "error"), c("t", "active"), "t", true],
    ["cancellation", c("u", "pending"), c("t", "active"), "t", true],
    ["invitation", c("u", "active"), c("t", "active"), "u", false],
    ["invitation", null, c("t", "active"), "t", false],
  ] as const)("%s, Mitarbeiter %o, Firma %o -> %s", (type, user, tenant, expected, fallback) => {
    const r = chooseSender(type, { user, tenant });
    expect(r.kind).toBe("send");
    if (r.kind === "send") {
      expect(r.connection.id).toBe(expected);
      expect(Boolean(r.fallbackReason)).toBe(fallback);
    }
  });

  it("Einladung wartet bei gestörtem Mitarbeiter-Postfach (kein Absenderwechsel)", () => {
    expect(chooseSender("invitation", { user: c("u", "error"), tenant: c("t", "active") })).toEqual({
      kind: "blocked",
      reason: expect.stringMatching(/u@firma\.example ist gestört/),
    });
  });

  it("ohne aktives Postfach: blockiert", () => {
    expect(chooseSender("confirmation", { user: c("u", "error"), tenant: c("t", "error") }).kind).toBe("blocked");
    expect(chooseSender("confirmation", { user: null, tenant: null })).toEqual({ kind: "blocked", reason: "Kein Postfach verbunden" });
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
