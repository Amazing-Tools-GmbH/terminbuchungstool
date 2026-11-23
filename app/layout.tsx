import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getCurrentTenant } from "@/lib/tenant/current";
import { parseTheme } from "@/lib/theme/schema";
import { themeToCssText } from "@/lib/theme/css";
import "./fonts.css";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const tenant = await getCurrentTenant();
  return {
    title: tenant ? `Terminbuchung · ${tenant.name}` : "Terminbuchung",
    robots: { index: false, follow: false },
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const tenant = await getCurrentTenant();
  // Ohne Mandant: neutrales Default-Theme
  const theme = tenant?.theme ?? parseTheme({});
  return (
    <html lang="de">
      <head>
        {/* Werte sind per zod-Schema auf sichere Muster beschränkt (lib/theme/schema.ts) */}
        <style id="tb-theme" dangerouslySetInnerHTML={{ __html: themeToCssText(theme) }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
