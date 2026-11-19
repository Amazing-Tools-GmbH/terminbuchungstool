import { describe, expect, it } from "vitest";
import { parsePipedriveCompanyDomain, tenantSlugFromPipedrive } from "@/lib/pipedrive/domain";

describe("Pipedrive-Unternehmensdomain -> Mandanten-Slug", () => {
  it.each([
    ["https://antennevorarlberg.pipedrive.com", "antennevorarlberg"],
    ["https://AntenneVorarlberg.pipedrive.com/", "antennevorarlberg"],
    ["antennevorarlberg.pipedrive.com", "antennevorarlberg"],
    ["antennevorarlberg", "antennevorarlberg"],
    ["muster-autohaus2", "muster-autohaus2"],
  ])("%s -> %s", (input, slug) => {
    expect(tenantSlugFromPipedrive(input)).toBe(slug);
  });

  it("lehnt fremde oder kaputte Domains ab", () => {
    for (const bad of ["https://evil.example.com", "a.b.pipedrive.com", "-firma", "", "https://", "fir ma"]) {
      expect(parsePipedriveCompanyDomain(bad), bad).toBeNull();
    }
  });

  it("reservierte Subdomains bekommen ein Suffix", () => {
    expect(tenantSlugFromPipedrive("https://www.pipedrive.com")).toBe("www-pd");
    expect(tenantSlugFromPipedrive("admin")).toBe("admin-pd");
  });
});
