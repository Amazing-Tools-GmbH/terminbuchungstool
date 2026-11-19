import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Verschlüsselung für gespeicherte Zugangsdaten (OAuth-Tokens, SMTP-Passwörter).
 * AES-256-GCM, Schlüssel aus ENCRYPTION_KEY (32 Byte, base64).
 * Format: "v1:<iv>:<tag>:<ciphertext>" (jeweils base64) – das "v1" erlaubt
 * später einen Schlüsselwechsel.
 */
const VERSION = "v1";

function loadKey(raw: string | undefined): Buffer {
  if (!raw) throw new Error("ENCRYPTION_KEY fehlt");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY muss 32 Byte (base64) lang sein");
  return key;
}

export function encryptSecret(plain: string, rawKey = process.env.ENCRYPTION_KEY): string {
  const key = loadKey(rawKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decryptSecret(sealed: string, rawKey = process.env.ENCRYPTION_KEY): string {
  const [version, iv, tag, ct] = sealed.split(":");
  if (version !== VERSION || !iv || !tag || ct === undefined) throw new Error("Unbekanntes Format für verschlüsselten Wert");
  const decipher = createDecipheriv("aes-256-gcm", loadKey(rawKey), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}
