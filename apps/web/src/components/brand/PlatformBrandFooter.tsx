import React from "react";
import styles from "./PlatformBrandFooter.module.css";

/** Compact platform footer: Jongo navigation only, with no Manifest co-branding. */
export default function PlatformBrandFooter() {
  return (
    <footer className={styles.footer} aria-label="Jongo platform footer">
      <nav className={styles.links} aria-label="Jongo footer links">
        <a href="https://jongo.app">Jongo <span aria-hidden="true">↗</span></a>
        <a href="/settings">Workspace settings</a>
      </nav>
    </footer>
  );
}