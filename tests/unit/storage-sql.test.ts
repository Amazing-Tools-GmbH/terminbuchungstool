import { describe, expect, it } from "vitest";
import { LocalAssetStorage, SupabaseAssetStorage, assetStorage, assetStorageKind } from "@/lib/storage";
import { inlineParams, sqlLiteral } from "@/scripts/supabase/api";

describe("Asset-Ablage wird explizit gewählt", () => {
  it("Standard ist lokal – auch wenn SUPABASE_URL gesetzt ist", () => {
    const env = { SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" };
    expect(assetStorageKind(env)).toBe("local");
    expect(assetStorage(env)).toBeInstanceOf(LocalAssetStorage);
  });
  it("ASSET_STORAGE=supabase nutzt Supabase Storage", () => {
    const env = { ASSET_STORAGE: "supabase", SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" };
    const s = assetStorage(env);
    expect(s).toBeInstanceOf(SupabaseAssetStorage);
    expect(s.publicUrl("00000000-0000-0000-0000-000000000000/logo.svg")).toBe(
      "https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/tenant-assets/00000000-0000-0000-0000-000000000000/logo.svg",
    );
  });
  it("Fehlkonfiguration fällt auf", () => {
    expect(() => assetStorageKind({ ASSET_STORAGE: "s3" })).toThrow(/ASSET_STORAGE/);
    expect(() => assetStorage({ ASSET_STORAGE: "supabase" })).toThrow(/SUPABASE_URL/);
  });
});

describe("SQL-Literale für die Management API", () => {
  it("escaped Zeichenketten und JSON", () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'");
    expect(sqlLiteral(null)).toBe("null");
    expect(sqlLiteral(42)).toBe("42");
    expect(sqlLiteral({ a: "x'y" })).toBe(`'{"a":"x''y"}'`);
    expect(sqlLiteral("a\\b")).toBe(" E'a\\\\b'");
    expect(sqlLiteral(Buffer.from([0xde, 0xad]))).toBe("'\\xdead'::bytea");
  });
  it("ersetzt $n und erkennt fehlende Parameter", () => {
    expect(inlineParams("select $1, $2, $1", ["a", 2])).toBe("select 'a', 2, 'a'");
    expect(inlineParams("select $10", Array.from({ length: 10 }, (_, i) => i))).toBe("select 9");
    expect(() => inlineParams("select $2", ["a"])).toThrow(/\$2/);
  });
  it("lehnt nicht-endliche Zahlen ab", () => {
    expect(() => sqlLiteral(Number.NaN)).toThrow();
  });
});
