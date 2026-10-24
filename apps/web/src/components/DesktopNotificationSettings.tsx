"use client";

import { useEffect, useState } from "react";
import {
  areDesktopNotificationsEnabled,
  getPermission,
  requestPermission,
  setDesktopNotificationsEnabled,
  type DesktopNotificationSupport
} from "@/lib/desktop-notifications";

const STATUS_COPY: Record<DesktopNotificationSupport, string> = {
  unsupported: "This browser does not support desktop notifications.",
  default: "Not enabled yet.",
  granted: "Browser permission is available.",
  denied: "Blocked. Allow notifications for this site in your browser's site settings to re-enable."
};

export default function DesktopNotificationSettings() {
  const [permission, setPermission] = useState<DesktopNotificationSupport>("unsupported");
  const [enabled, setEnabled] = useState(false);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    const currentPermission = getPermission();
    setPermission(currentPermission);
    setEnabled(currentPermission === "granted" && areDesktopNotificationsEnabled());
  }, []);

  async function handleEnable() {
    setRequesting(true);
    try {
      const nextPermission = await requestPermission();
      setPermission(nextPermission);
      const nextEnabled = nextPermission === "granted";
      setDesktopNotificationsEnabled(nextEnabled);
      setEnabled(nextEnabled);
    } finally {
      setRequesting(false);
    }
  }

  function handleToggle(checked: boolean) {
    setDesktopNotificationsEnabled(checked);
    setEnabled(checked);
  }

  return (
    <article className="card">
      <h3 className="card-title">Notifications</h3>
      <p className="card-muted" style={{ margin: "0.3rem 0 0.85rem", fontSize: "0.85rem" }}>
        {STATUS_COPY[permission]}
      </p>

      {permission === "default" ? (
        <button type="button" className="btn" onClick={() => void handleEnable()} disabled={requesting}>
          {requesting ? "Requesting…" : "Enable notifications"}
        </button>
      ) : null}

      {permission === "granted" ? (
        <div style={{ display: "grid", gap: "0.6rem" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <input type="checkbox" checked={enabled} onChange={(e) => handleToggle(e.target.checked)} />
            Desktop notifications
          </label>
          <p className="card-muted" style={{ margin: 0, fontSize: "0.8rem" }}>
            This controls desktop pop-ups for new Jongo notifications. In-app notifications remain available.
          </p>
        </div>
      ) : null}
    </article>
  );
}
