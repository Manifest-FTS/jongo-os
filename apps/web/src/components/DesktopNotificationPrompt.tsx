"use client";

import { useEffect, useState } from "react";
import {
  dismissPromptForSession,
  getPermission,
  isPromptDismissedThisSession,
  requestPermission,
  type DesktopNotificationSupport
} from "@/lib/desktop-notifications";

/**
 * A banner, not a one-shot dialog: it reappears every new session until the
 * visitor either grants or denies the browser permission, because a toast
 * that vanishes after one page load is easy to miss entirely on a first
 * visit. "Not now" only defers it to next session; there is no permanent
 * dismissal short of the browser's own permission decision.
 */
export default function DesktopNotificationPrompt() {
  const [permission, setPermission] = useState<DesktopNotificationSupport>("unsupported");
  const [visible, setVisible] = useState(false);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    const current = getPermission();
    setPermission(current);
    setVisible(current === "default" && !isPromptDismissedThisSession());
  }, []);

  if (!visible || permission !== "default") {
    return null;
  }

  async function handleEnable() {
    setRequesting(true);
    try {
      const result = await requestPermission();
      setPermission(result);
      setVisible(false);
    } finally {
      setRequesting(false);
    }
  }

  function handleDismiss() {
    dismissPromptForSession();
    setVisible(false);
  }

  return (
    <div
      role="status"
      style={{
        position: "fixed",
        bottom: "1.25rem",
        right: "1.25rem",
        zIndex: 90,
        width: "min(360px, calc(100vw - 2.5rem))",
        background: "#ffffff",
        border: "1px solid var(--border)",
        borderRadius: "14px",
        boxShadow: "0 24px 60px rgba(15, 23, 42, 0.22)",
        padding: "1rem"
      }}
    >
      <p style={{ margin: 0, fontWeight: 700 }}>Enable desktop notifications?</p>
      <p className="card-muted" style={{ margin: "0.4rem 0 0.85rem", fontSize: "0.85rem" }}>
        Get an alert and sound the moment a new notification arrives, even in another tab.
      </p>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button type="button" className="btn" onClick={() => void handleEnable()} disabled={requesting}>
          {requesting ? "Requesting…" : "Enable"}
        </button>
        <button type="button" className="btn" onClick={handleDismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}
