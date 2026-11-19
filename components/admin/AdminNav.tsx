"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./Admin.module.css";

export type NavItem = { href: string | null; label: string; soon?: string };

/** Seitennavigation; markiert den aktiven Bereich (aria-current) */
export function AdminNav({ items, label }: { items: NavItem[]; label: string }) {
  const path = usePathname();
  return (
    <nav className={styles.nav} aria-label={label}>
      <ul>
        {items.map((it) => (
          <li key={it.label}>
            {it.href ? (
              <Link className={styles.navLink} href={it.href} aria-current={path === it.href ? "page" : undefined}>
                {it.label}
              </Link>
            ) : (
              <span className={styles.navSoon} aria-disabled="true">
                {it.label} <span>{it.soon}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
