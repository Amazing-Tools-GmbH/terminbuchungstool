/** Erscheinungsbild speichern: nur owner/admin (RLS), Logo landet im Asset-Storage */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTestDb, type TestDb } from "./helpers";
import type { AdminContext } from "@/lib/auth/admin";

let db: TestDb;
let branding: typeof import("@/lib/admin/branding");
let owner: AdminContext;
let sales: AdminContext;
let tenantId: string;

beforeAll(async () => {
  db = await setupTestDb();
  process.env.SUPABASE_DB_URL = "";
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  branding = await import("@/lib/admin/branding");
  const a = db.seed.find((s) => s.slug === "antennevorarlberg")!;
  tenantId = a.tenantId;
  const m = await db.admin<{ user_id: string; role: "owner" | "admin" | "sales" }>(
    "select user_id, role::text as role from tenant_members where tenant_id = $1 and status = 'active'",
    [a.tenantId],
  );
  const tenant = { id: a.tenantId, timezone: "Europe/Vienna" } as AdminContext["tenant"];
  const ctx = (role: "owner" | "sales"): AdminContext => {
    const userId = m.find((x) => x.role === role)!.user_id;
    return { tenant, userId, actor: { role: "authenticated", userId }, role, name: null, email: null };
  };
  owner = ctx("owner");
  sales = ctx("sales");
});

afterAll(async () => {
  await globalThis.__tbPool?.end();
  globalThis.__tbPool = undefined;
  await db?.close();
});

const tenantRow = async () =>
  (await db.admin<{ theme: Record<string, string>; claim: string | null; logo_path: string | null }>("select theme, claim, logo_path from tenants where id = $1", [tenantId]))[0]!;

const colors = { headerBg: "#FFFFFF", headerInk: "#111111", primary: "#0A3D91", onPrimary: "#FFFFFF" };

describe("Erscheinungsbild", () => {
  it("owner speichert Claim, Farben, Schriften", async () => {
    await branding.saveBranding(owner, { claim: "Neuer Claim", fontBody: "Lato", fontDisplay: "Montserrat", colors });
    const t = await tenantRow();
    expect(t.claim).toBe("Neuer Claim");
    expect(t.theme).toMatchObject({ ...colors, fontBody: "Lato", fontDisplay: "Montserrat" });
  });

  it("sales darf nichts ändern", async () => {
    await expect(branding.saveBranding(sales, { claim: null, fontBody: "Inter", fontDisplay: "Inter", colors })).rejects.toMatchObject({ code: "forbidden" });
    await expect(branding.removeLogo(sales)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("schlechter Kontrast wird nicht gespeichert", async () => {
    await expect(
      branding.saveBranding(owner, { claim: null, fontBody: "Inter", fontDisplay: "Inter", colors: { primary: "#FFFFFF", onPrimary: "#FAFAFA" } }),
    ).rejects.toMatchObject({ code: "contrast_too_low" });
    expect((await tenantRow()).claim).toBe("Neuer Claim");
  });

  it("Logo: Typ und Größe werden geprüft, Pfad wird gespeichert und entfernt", async () => {
    const storage = await import("@/lib/storage");
    const put: { key: string; type: string }[] = [];
    const spy = vi.spyOn(storage, "assetStorage").mockReturnValue({
      put: async (key: string, _b: Buffer, type: string) => void put.push({ key, type }),
      publicUrl: (k: string) => `/x/${k}`,
    });
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], "logo.png", { type: "image/png" });
    await branding.saveLogo(owner, png);
    expect(put[0]!.key).toMatch(new RegExp(`^${tenantId}/logo-\\d+\\.png$`));
    expect(put[0]!.type).toBe("image/png");
    expect((await tenantRow()).logo_path).toBe(put[0]!.key);

    const fake = new File(["<html>nope</html>"], "logo.png", { type: "image/png" });
    await expect(branding.saveLogo(owner, fake)).rejects.toMatchObject({ code: "logo_invalid" });
    const big = new File([new Uint8Array(branding.LOGO_MAX_BYTES + 1)], "big.png");
    await expect(branding.saveLogo(owner, big)).rejects.toMatchObject({ code: "logo_too_large" });
    await expect(branding.saveLogo(sales, png)).rejects.toMatchObject({ code: "forbidden" });

    await branding.removeLogo(owner);
    expect((await tenantRow()).logo_path).toBeNull();
    spy.mockRestore();
  });
});
