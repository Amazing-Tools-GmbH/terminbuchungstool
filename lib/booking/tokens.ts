import { createHash, randomBytes } from "node:crypto";

/**
 * Buchungslink-Token: 32 zufällige Bytes, base64url (43 Zeichen).
 * In der DB steht nur sha256(token) (siehe app.hash_token).
 */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Grobe Formprüfung vor jeder DB-Abfrage */
export function looksLikeToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{20,200}$/.test(token);
}
