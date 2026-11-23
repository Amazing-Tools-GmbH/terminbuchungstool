#!/usr/bin/env node
/**
 * Lädt die Schriften der Allowlist EINMALIG von Google Fonts herunter und legt sie im
 * Repository ab (public/fonts/…, app/fonts.css). Der Build braucht danach keinen Zugriff
 * auf Google mehr; Besucher laden die Schriften nur von unserer Domain.
 *
 *   NODE_USE_ENV_PROXY=1 node scripts/fonts-download.mjs   (Proxy nur in der Cloud-Umgebung nötig)
 *
 * Neue Schrift: unten in FONTS ergänzen, in lib/theme/font-names.ts eintragen, Skript ausführen,
 * Ergebnis committen. Lizenz: alle Schriften stehen unter der SIL Open Font License bzw. Apache 2.0.
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";

const FONTS = [
  ["Overpass", [400, 600, 700, 800]],
  ["Inter", [400, 600, 700, 800]],
  ["Roboto", [400, 500, 700]],
  ["Open Sans", [400, 600, 700, 800]],
  ["Lato", [400, 700, 900]],
  ["Montserrat", [400, 600, 700, 800]],
  ["Source Sans 3", [400, 600, 700, 800]],
  ["Nunito Sans", [400, 600, 700, 800]],
  ["Work Sans", [400, 600, 700, 800]],
  ["IBM Plex Sans", [400, 600, 700]],
  ["Merriweather", [400, 700, 900]],
  ["Lora", [400, 600, 700]],
];
const SUBSETS = new Set(["latin", "latin-ext"]);
// moderner Browser -> woff2 mit unicode-range je Subset
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

async function get(url, as = "text") {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": UA } });
    if (res.ok) return as === "text" ? res.text() : Buffer.from(await res.arrayBuffer());
    if (attempt >= 3) throw new Error(`${res.status} für ${url}`);
  }
}

await rm("public/fonts", { recursive: true, force: true });
const css = [
  "/* Erzeugt von scripts/fonts-download.mjs – nicht von Hand ändern. */",
  "/* Selbst gehostete Schriften (SIL OFL / Apache 2.0), ausgeliefert von unserer Domain. */",
  "",
];
const vars = [];
let files = 0;
for (const [name, weights] of FONTS) {
  const family = name.replace(/ /g, "+");
  const sheet = await get(`https://fonts.googleapis.com/css2?family=${family}:wght@${weights.join(";")}&display=swap`);
  const blocks = [...sheet.matchAll(/\/\*\s*([a-z-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)];
  const seen = new Map();
  for (const [, subset, body] of blocks) {
    if (!SUBSETS.has(subset)) continue;
    const src = /url\((https:[^)]+)\)/.exec(body)?.[1];
    const weight = /font-weight:\s*([^;]+);/.exec(body)?.[1].trim();
    const style = /font-style:\s*([^;]+);/.exec(body)?.[1].trim() ?? "normal";
    const range = /unicode-range:\s*([^;]+);/.exec(body)?.[1].trim();
    if (!src || !weight || !range) throw new Error(`Unerwarteter @font-face-Block für ${name}`);
    let file = seen.get(src);
    if (!file) {
      const data = await get(src, "buffer");
      if (data.subarray(0, 4).toString("latin1") !== "wOF2") throw new Error(`Keine woff2-Datei: ${src}`);
      file = `/fonts/${slug(name)}/${slug(name)}-${subset}-${createHash("sha256").update(data).digest("hex").slice(0, 8)}.woff2`;
      await mkdir(`public/fonts/${slug(name)}`, { recursive: true });
      await writeFile(`public${file}`, data);
      seen.set(src, file);
      files++;
    }
    css.push(
      `/* ${name} ${weight} ${subset} */`,
      `@font-face {`,
      `  font-family: "${name}";`,
      `  font-style: ${style};`,
      `  font-weight: ${weight};`,
      `  font-display: swap;`,
      `  src: url("${file}") format("woff2");`,
      `  unicode-range: ${range};`,
      `}`,
    );
  }
  vars.push(`  --font-${slug(name)}: "${name}";`);
}
css.push("", "/* Variablen, auf die lib/theme/font-stack.ts verweist */", ":root {", ...vars, "}", "");
await writeFile("app/fonts.css", css.join("\n"));
console.log(`${files} Schriftdateien, app/fonts.css geschrieben`);
