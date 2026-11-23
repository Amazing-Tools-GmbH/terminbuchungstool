"use client";
/**
 * Meldet das Panel beim Pipedrive-SDK an (nur im Pipedrive-iframe mit Kennung ?id=…)
 * und passt die Höhe an. Ohne diese Anmeldung zeigt Pipedrive nach kurzer Zeit seine
 * eigene Meldung „Etwas ist schief gelaufen…“ – darum auch auf Fehlerseiten verwenden.
 */
import { useEffect, useRef, type RefObject } from "react";

export type PipedriveSdk = { execute: (cmd: string, args?: unknown) => Promise<unknown> };

export function usePipedriveSdk(rootRef: RefObject<HTMLElement | null>) {
  const sdk = useRef<PipedriveSdk | null>(null);
  useEffect(() => {
    if (window.self === window.top || !new URLSearchParams(window.location.search).get("id")) return;
    let stop = () => {};
    (async () => {
      try {
        const mod = await import("@pipedrive/app-extensions-sdk");
        const height = () => Math.ceil(document.documentElement.scrollHeight);
        const instance = await new mod.default().initialize({ size: { height: height() } });
        sdk.current = instance as unknown as PipedriveSdk;
        const ro = new ResizeObserver(() => {
          void sdk.current?.execute(mod.Command.RESIZE, { height: height() }).catch(() => {});
        });
        if (rootRef.current) ro.observe(rootRef.current);
        stop = () => ro.disconnect();
      } catch (err) {
        console.error("Pipedrive-SDK konnte nicht initialisiert werden", err);
        sdk.current = null;
      }
    })();
    return () => stop();
  }, [rootRef]);
  return sdk;
}
