import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secretbox";
import { generateToken, hashToken, looksLikeToken } from "@/lib/booking/tokens";

const key = randomBytes(32).toString("base64");

describe("secretbox", () => {
  it("verschlüsselt und entschlüsselt", () => {
    const sealed = encryptSecret("geheim-ä€", key);
    expect(sealed).toMatch(/^v1:/);
    expect(sealed).not.toContain("geheim");
    expect(decryptSecret(sealed, key)).toBe("geheim-ä€");
  });

  it("erkennt Manipulation und falsche Schlüssel", () => {
    const sealed = encryptSecret("x", key);
    const parts = sealed.split(":");
    parts[3] = Buffer.from("y").toString("base64");
    expect(() => decryptSecret(parts.join(":"), key)).toThrow();
    expect(() => decryptSecret(sealed, randomBytes(32).toString("base64"))).toThrow();
    expect(() => encryptSecret("x", "zu-kurz")).toThrow(/32 Byte/);
  });
});

describe("Buchungslink-Tokens", () => {
  it("sind zufällig, URL-sicher und 256 Bit lang", () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(a);
    expect(looksLikeToken(a)).toBe(true);
    expect(looksLikeToken("x'; drop table")).toBe(false);
  });

  it("Hash entspricht sha256 (wie app.hash_token in der DB)", () => {
    expect(hashToken("abc").toString("hex")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
