"use client";

import React, { useId, useState } from "react";
import styles from "./PlatformBrandFooter.module.css";

export interface PlatformBrandFooterProps {
  markTone?: "lime" | "teal" | "blue";
}

/** Parent-owned placement: this footer never changes the platform shell or navigation. */
export default function PlatformBrandFooter({ markTone = "lime" }: PlatformBrandFooterProps) {
  const [paused, setPaused] = useState(false);
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const sealId = `manifest-seal-${instanceId}`;
  const pathId = `${sealId}-path`;

  return (
    <footer className={styles.footer} aria-label="Manifest" data-motion-paused={paused}>
      <svg className={styles.ambient} viewBox="0 0 1000 360" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
        <path d="M40 330 190 70 340 330Z M710 40 870 315 550 315Z" />
        <circle cx="890" cy="85" r="115" />
        <circle cx="890" cy="85" r="78" />
      </svg>

      <div className={styles.content}>
        <div className={styles.signature}>
          <span className={styles.lockup} role="img" aria-label="Manifest">
            <span className={styles.mark} data-tone={markTone} aria-hidden="true" />
            <span className={styles.wordmark} aria-hidden="true">Manifest</span>
          </span>
          <p className={styles.tagline}>Forward thinking.<br />Thoughtfully made.</p>
        </div>

        <div className={styles.sealColumn}>
          <div className={styles.seal} id={sealId}>
            <svg viewBox="0 0 200 200" role="img" aria-label="Forward thinking solutions" focusable="false">
              <defs>
                <path id={pathId} d="M100 100 m-76 0 a76 76 0 1 1 152 0 a76 76 0 1 1-152 0" />
              </defs>
              <g className={styles.ring}>
                <text textLength="465" lengthAdjust="spacing">
                  <textPath href={`#${pathId}`} startOffset="0%">FORWARD THINKING SOLUTIONS</textPath>
                </text>
              </g>
            </svg>
            <span className={`${styles.mark} ${styles.sealMark}`} aria-hidden="true" />
          </div>
          <button
            className={styles.pause}
            type="button"
            aria-pressed={paused}
            aria-controls={sealId}
            onClick={() => setPaused((previous) => !previous)}
          >
            Pause seal animation
          </button>
        </div>

        <nav className={styles.links} aria-label="Manifest footer links">
          <a href="https://manifestfts.com">Manifest <span aria-hidden="true">↗</span></a>
          <a href="https://jongo.app">Jongo <span aria-hidden="true">↗</span></a>
          <a href="/settings">Workspace settings</a>
        </nav>
      </div>
    </footer>
  );
}