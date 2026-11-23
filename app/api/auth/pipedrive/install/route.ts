import { NextResponse } from "next/server";
import { installUrl, oauthConfig } from "@/lib/pipedrive/client";
import { appUrl } from "@/lib/auth/urls";

export const dynamic = "force-dynamic";

/**
 * "App in Pipedrive installieren": leitet zur Pipedrive-Freigabe ohne state weiter.
 * Der zentrale Callback behandelt das als Installation.
 */
export async function GET() {
  const cfg = oauthConfig();
  if (!cfg) return NextResponse.redirect(appUrl("/admin/login", { error: "not_configured" }));
  return NextResponse.redirect(installUrl(cfg));
}
