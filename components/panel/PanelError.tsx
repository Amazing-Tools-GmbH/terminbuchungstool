"use client";
/** Fehlermeldung im Panel – meldet sich trotzdem beim Pipedrive-SDK an, damit die Meldung sichtbar ist */
import { useRef } from "react";
import { usePipedriveSdk } from "./usePipedriveSdk";
import styles from "./Panel.module.css";

export function PanelError({ message, code, theme }: { message: string; code: string; theme: "light" | "dark" }) {
  const rootRef = useRef<HTMLElement>(null);
  usePipedriveSdk(rootRef);
  return (
    <main ref={rootRef} className={styles.root} data-theme={theme}>
      <p role="alert" className={styles.alert}>
        {message}
      </p>
      <p className={styles.hint}>Code: {code}</p>
    </main>
  );
}
