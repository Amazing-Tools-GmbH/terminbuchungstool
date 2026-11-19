import "server-only";
/**
 * Postfach verbinden, testen, trennen – Serverlogik für Admin-Backend und
 * OAuth-Routen. Speichern/Testen läuft als angemeldeter Benutzer über
 * SECURITY-DEFINER-Funktionen (Rechte in der DB); nur der OAuth-Zwischen-
 * speicher (ohne Sitzung) und das Lesen von Zugangsdaten zum Widerrufen
 * laufen als service_role.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { withActor } from "@/lib/db";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secretbox";
import type { AdminContext } from "@/lib/auth/admin";
import { AdminError, toAdminError } from "@/lib/admin/errors";
import { oauthCredentialsSchema, revokeMailAccess, type ConnectedMailbox, type MailOAuthProviderId } from "./oauth";
import type { MailState } from "@/lib/auth/session";
import type { SmtpCredentials } from "./senders/smtp";

export type MailScope = "user" | "tenant";

export type MailboxView = {
  id: string;
  scope: MailScope;
  provider: "google" | "microsoft" | "smtp" | "dev";
  senderEmail: string;
  senderName: string | null;
  status: "pending" | "active" | "error" | "revoked";
  lastError: string | null;
  lastVerifiedAt: Date | null;
  userId: string | null;
};

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

type Row = {
  id: string;
  scope: MailScope;
  provider: MailboxView["provider"];
  sender_email: string;
  sender_name: string | null;
  status: MailboxView["status"];
  last_error: string | null;
  last_verified_at: Date | null;
  user_id: string | null;
};
const toView = (r: Row): MailboxView => ({
  id: r.id,
  scope: r.scope,
  provider: r.provider,
  senderEmail: r.sender_email,
  senderName: r.sender_name,
  status: r.status,
  lastError: r.last_error,
  lastVerifiedAt: r.last_verified_at,
  userId: r.user_id,
});
const COLS = "id, scope::text as scope, provider::text as provider, sender_email, sender_name, status::text as status, last_error, last_verified_at, user_id";

/** Eigenes Postfach + Firmenpostfach (Adresse/Status, für alle Mitglieder) */
export async function loadMyMailbox(ctx: AdminContext) {
  return withActor(ctx.actor, async (db) => {
    const { rows } = await db.query<Row>(
      `select ${COLS} from public.mail_connections where tenant_id = $1 and scope = 'user' and user_id = $2`,
      [ctx.tenant.id, ctx.userId],
    );
    const { rows: t } = await db.query<{ sender_email: string; provider: string; status: string }>(
      "select sender_email, provider::text, status::text from public.get_tenant_mailbox($1)",
      [ctx.tenant.id],
    );
    return { mine: rows[0] ? toView(rows[0]) : null, tenantMailbox: t[0] ?? null };
  });
}

export type MailSettings = {
  tenantMailbox: MailboxView | null;
  smartBccEmail: string | null;
  team: { userId: string; name: string; role: string; mailbox: MailboxView | null }[];
  fallbacks: { sentAt: Date; toEmail: string; type: string; reason: string }[];
};

/** E-Mail-Einstellungen der Firma (owner/admin; RLS liefert sonst nichts) */
export async function loadMailSettings(ctx: AdminContext): Promise<MailSettings> {
  return withActor(ctx.actor, async (db) => {
    const { rows: conns } = await db.query<Row>(`select ${COLS} from public.mail_connections where tenant_id = $1`, [ctx.tenant.id]);
    const { rows: t } = await db.query<{ smart_bcc_email: string | null }>("select smart_bcc_email from public.tenants where id = $1", [
      ctx.tenant.id,
    ]);
    const { rows: members } = await db.query<{ user_id: string; display_name: string | null; email: string | null; role: string }>(
      `select user_id, display_name, email, role::text from public.tenant_members
        where tenant_id = $1 and status = 'active' order by role, display_name`,
      [ctx.tenant.id],
    );
    const { rows: fb } = await db.query<{ sent_at: Date; to_email: string; type: string; sender_fallback_reason: string }>(
      `select sent_at, to_email, type::text, sender_fallback_reason from public.email_outbox
        where tenant_id = $1 and sender_fallback_reason is not null and sent_at > now() - interval '30 days'
        order by sent_at desc limit 20`,
      [ctx.tenant.id],
    );
    const views = conns.map(toView);
    return {
      tenantMailbox: views.find((v) => v.scope === "tenant") ?? null,
      smartBccEmail: t[0]?.smart_bcc_email ?? null,
      team: members.map((m) => ({
        userId: m.user_id,
        name: m.display_name ?? m.email ?? "—",
        role: m.role,
        mailbox: views.find((v) => v.scope === "user" && v.userId === m.user_id) ?? null,
      })),
      fallbacks: fb.map((f) => ({ sentAt: f.sent_at, toEmail: f.to_email, type: f.type, reason: f.sender_fallback_reason })),
    };
  });
}

async function saveConnection(
  ctx: AdminContext,
  scope: MailScope,
  provider: "google" | "microsoft" | "smtp",
  senderEmail: string,
  senderName: string | null,
  credentialsEnc: string,
  grantedScopes: string | null,
): Promise<string> {
  return withActor(ctx.actor, async (db) => {
    const { rows } = await db.query<{ id: string }>("select public.save_mail_connection($1, $2, $3, $4, $5, $6, $7) as id", [
      ctx.tenant.id,
      scope,
      provider,
      senderEmail,
      senderName,
      credentialsEnc,
      grantedScopes,
    ]);
    const id = rows[0]!.id;
    // Testmail an das Postfach selbst; erst nach erfolgreichem Versand "active"
    await db.query("select public.request_mail_test($1)", [id]);
    return id;
  });
}

/** SMTP-Postfach speichern (Passwort verschlüsselt) und Testmail anstoßen */
export async function saveSmtpMailbox(ctx: AdminContext, scope: MailScope, input: SmtpCredentials & { senderEmail: string; senderName: string | null }) {
  try {
    const { senderEmail, senderName, ...creds } = input;
    return await saveConnection(ctx, scope, "smtp", senderEmail, senderName, encryptSecret(JSON.stringify(creds)), null);
  } catch (err) {
    throw toAdminError(err);
  }
}

/** OAuth-Callback (zentrale Adresse, ohne Sitzung): Ergebnis kurz zwischenspeichern */
export async function storePendingMailbox(state: MailState, mailbox: ConnectedMailbox): Promise<string> {
  return withActor({ role: "service_role" }, async (db) => {
    await db.query("delete from public.mail_oauth_pending where expires_at < now()");
    const { rows } = await db.query<{ id: string }>(
      `insert into public.mail_oauth_pending
         (tenant_id, user_id, scope, provider, sender_email, sender_name, credentials_enc, granted_scopes, nonce_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [
        state.tid,
        state.uid,
        state.scope,
        state.provider,
        mailbox.email,
        mailbox.name,
        encryptSecret(JSON.stringify(mailbox.credentials)),
        mailbox.grantedScopes,
        sha256(state.nonce),
      ],
    );
    return rows[0]!.id;
  });
}

/**
 * Abschluss auf der Mandanten-Adresse: nur derselbe Benutzer, im selben
 * Browser (Nonce-Cookie), innerhalb der Frist. Dann speichern + Testmail.
 */
export async function finishPendingMailbox(ctx: AdminContext, pendingId: string, nonce: string | undefined): Promise<{ id: string; scope: MailScope }> {
  const pending = await withActor({ role: "service_role" }, async (db) => {
    const { rows } = await db.query<{
      scope: MailScope;
      provider: MailOAuthProviderId;
      sender_email: string;
      sender_name: string | null;
      credentials_enc: string;
      granted_scopes: string | null;
      nonce_hash: Buffer;
    }>(
      `delete from public.mail_oauth_pending
        where id = $1 and tenant_id = $2 and user_id = $3 and expires_at > now()
        returning scope::text as scope, provider::text as provider, sender_email, sender_name, credentials_enc, granted_scopes, nonce_hash`,
      [pendingId, ctx.tenant.id, ctx.userId],
    );
    return rows[0] ?? null;
  });
  if (!pending || !nonce) throw new AdminError("mail_expired");
  const h = sha256(nonce);
  if (h.length !== pending.nonce_hash.length || !timingSafeEqual(h, pending.nonce_hash)) throw new AdminError("mail_expired");
  try {
    const id = await saveConnection(
      ctx,
      pending.scope,
      pending.provider,
      pending.sender_email,
      pending.sender_name,
      pending.credentials_enc,
      pending.granted_scopes,
    );
    return { id, scope: pending.scope };
  } catch (err) {
    throw toAdminError(err);
  }
}

export async function requestTestMail(ctx: AdminContext, connectionId: string): Promise<void> {
  try {
    await withActor(ctx.actor, (db) => db.query("select public.request_mail_test($1)", [connectionId]));
  } catch (err) {
    throw toAdminError(err);
  }
}

/** Trennen: bei Google den Zugang widerrufen, dann löschen (Rechte per RLS) */
export async function disconnectMailbox(ctx: AdminContext, connectionId: string): Promise<void> {
  try {
    const visible = await withActor(ctx.actor, async (db) => {
      const { rows } = await db.query<{ provider: string }>(
        "select provider::text from public.mail_connections where id = $1 and tenant_id = $2",
        [connectionId, ctx.tenant.id],
      );
      return rows[0] ?? null;
    });
    if (!visible) throw new AdminError("not_found");
    // Zugangsdaten zum Widerrufen lesen (nur Server); erst NACH der Sichtbarkeitsprüfung
    const enc = await withActor({ role: "service_role" }, async (db) => {
      const { rows } = await db.query<{ credentials_enc: string | null }>("select credentials_enc from public.mail_connections where id = $1", [
        connectionId,
      ]);
      return rows[0]?.credentials_enc ?? null;
    });
    const deleted = await withActor(ctx.actor, async (db) => {
      const res = await db.query("delete from public.mail_connections where id = $1 and tenant_id = $2", [connectionId, ctx.tenant.id]);
      return res.rowCount === 1;
    });
    if (!deleted) throw new AdminError("forbidden");
    if (enc && (visible.provider === "google" || visible.provider === "microsoft")) {
      try {
        const creds = oauthCredentialsSchema.safeParse(JSON.parse(decryptSecret(enc)));
        if (creds.success) await revokeMailAccess(visible.provider, creds.data);
      } catch {
        // Widerruf ist best effort – die Verbindung ist bei uns bereits gelöscht
      }
    }
  } catch (err) {
    throw toAdminError(err);
  }
}

export async function saveSmartBcc(ctx: AdminContext, email: string | null): Promise<void> {
  try {
    await withActor(ctx.actor, async (db) => {
      const res = await db.query("update public.tenants set smart_bcc_email = $2 where id = $1", [ctx.tenant.id, email]);
      if (res.rowCount === 0) throw new AdminError("forbidden");
    });
  } catch (err) {
    throw toAdminError(err);
  }
}

/** Nur Entwicklung: dev-Postfach (Mails nur in /dev/mails) ohne Anbieter verbinden */
export async function connectDevMailbox(ctx: AdminContext, scope: MailScope): Promise<void> {
  if (scope === "tenant" && ctx.role === "sales") throw new AdminError("forbidden");
  const email = (scope === "user" ? ctx.email : null) ?? `postfach-${ctx.tenant.slug}@dev.example`;
  const id = await withActor({ role: "service_role" }, async (db) => {
    const existing = await db.query<{ id: string }>(
      `select id from public.mail_connections where tenant_id = $1 and scope = $2 and (scope = 'tenant' or user_id = $3)`,
      [ctx.tenant.id, scope, ctx.userId],
    );
    if (existing.rows[0]) {
      await db.query(
        "update public.mail_connections set provider = 'dev', sender_email = $2, credentials_enc = null, status = 'pending', last_error = null where id = $1",
        [existing.rows[0].id, email],
      );
      return existing.rows[0].id;
    }
    const { rows } = await db.query<{ id: string }>(
      `insert into public.mail_connections (tenant_id, scope, user_id, provider, sender_email, sender_name, status)
       values ($1, $2, $3, 'dev', $4, $5, 'pending') returning id`,
      [ctx.tenant.id, scope, scope === "user" ? ctx.userId : null, email, ctx.name],
    );
    return rows[0]!.id;
  });
  await requestTestMail(ctx, id);
}
