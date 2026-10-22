import React from "react";
import Link from "next/link";
import JongoBrandLockup from "./JongoBrandLockup";
import styles from "./PlatformBrandFooter.module.css";

/** Compact Jongo platform footer using Jongo's own logo and destinations. */
export default function PlatformBrandFooter() {
  return (
    <footer className={styles.footer} aria-label="Jongo platform footer">
      <Link href="/dashboard" className={styles.home} aria-label="Jongo dashboard home">
        <JongoBrandLockup />
      </Link>
      <nav className={styles.links} aria-label="Jongo footer links">
        <Link href="/settings">Workspace settings</Link>
      </nav>
    </footer>
  );
}
