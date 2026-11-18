import { describe, expect, it } from "vitest";
import { decodeTenantKey, encodeTenantKey, parseTenantKey, tenantQueryAllowed } from "@/lib/tenant/host";

const base = { appDomain: "termine.example.at", allowQuery: false };

describe("parseTenantKey", () => {
  it("Subdomain -> Slug", () => {
    expect(parseTenantKey({ ...base, host: "antenne-vorarlberg.termine.example.at" })).toEqual({ kind: "slug", slug: "antenne-vorarlberg" });
    expect(parseTenantKey({ ...base, host: "Demo.Termine.Example.at" })).toEqual({ kind: "slug", slug: "demo" });
  });

  it("App-Domain selbst, reservierte und verschachtelte Subdomains -> kein Mandant", () => {
    expect(parseTenantKey({ ...base, host: "termine.example.at" })).toBeNull();
    expect(parseTenantKey({ ...base, host: "www.termine.example.at" })).toBeNull();
    expect(parseTenantKey({ ...base, host: "a.b.termine.example.at" })).toBeNull();
  });

  it("fremder Host -> custom_domain (ohne Port)", () => {
    expect(parseTenantKey({ ...base, host: "buchung.kunde.at:443" })).toEqual({ kind: "domain", domain: "buchung.kunde.at" });
    expect(parseTenantKey({ ...base, host: "kaputt_host" })).toBeNull();
  });

  it("localhost mit Port", () => {
    const local = { appDomain: "localhost:3000", allowQuery: false };
    expect(parseTenantKey({ ...local, host: "demo.localhost:3000" })).toEqual({ kind: "slug", slug: "demo" });
    expect(parseTenantKey({ ...local, host: "localhost:3000" })).toBeNull();
  });

  it("?tenant= nur, wenn erlaubt – dann mit Vorrang", () => {
    const host = "projekt-abc123.vercel.app";
    expect(parseTenantKey({ ...base, host, queryTenant: "demo" })).toEqual({ kind: "domain", domain: host });
    expect(parseTenantKey({ ...base, host, queryTenant: "demo", allowQuery: true })).toEqual({ kind: "slug", slug: "demo" });
    expect(parseTenantKey({ ...base, host, cookieTenant: "demo", allowQuery: true })).toEqual({ kind: "slug", slug: "demo" });
    expect(parseTenantKey({ ...base, host, queryTenant: "../x", allowQuery: true })).toEqual({ kind: "domain", domain: host });
  });
});

describe("tenantQueryAllowed", () => {
  it("nie in Produktion", () => {
    expect(tenantQueryAllowed({ VERCEL_ENV: "production", ALLOW_TENANT_QUERY_PARAM: "true" })).toBe(false);
    expect(tenantQueryAllowed({ VERCEL_ENV: "preview", ALLOW_TENANT_QUERY_PARAM: "true" })).toBe(true);
    expect(tenantQueryAllowed({ ALLOW_TENANT_QUERY_PARAM: "true" })).toBe(true);
    expect(tenantQueryAllowed({})).toBe(false);
  });
});

describe("Header-Kodierung", () => {
  it("roundtrip und Ablehnung von Müll", () => {
    expect(decodeTenantKey(encodeTenantKey({ kind: "slug", slug: "demo" }))).toEqual({ kind: "slug", slug: "demo" });
    expect(decodeTenantKey(encodeTenantKey({ kind: "domain", domain: "a.kunde.at" }))).toEqual({ kind: "domain", domain: "a.kunde.at" });
    expect(decodeTenantKey("slug:Böse")).toBeNull();
    expect(decodeTenantKey(null)).toBeNull();
  });
});
