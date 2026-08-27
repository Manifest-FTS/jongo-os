"use client";

import { useEffect, useState } from "react";
import {
  getPermission,
  isSoundEnabled,
  playAlertSound,
  requestPermission,
  setSoundEnabled,
  showDesktopNotification,
  type DesktopNotificationSupport
} from "@/lib/desktop-notifications";

const STATUS_COPY: Record<DesktopNotificationSupport, string> = {
  unsupported: "This browser does not support desktop notifications.",
  default: "Not enabled yet.",
  granted: "Enabled.",
  denied: "Blocked. Allow notifications for this site in your browser's site settings to re-enable."
};

export default function DesktopNotificationSettings() {
  const [permission, setPermission] = useState<DesktopNotificationSupport>("unsupported");
  const [soundEnabled, setSoundEnabledState] = useState(true);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    setPermission(getPermission());
    setSoundEnabledState(isSoundEnabled());
  }, []);

  async function handleEnable() {
    setRequesting(true);
    try {
      setPermission(await requestPermission());
    } finally {
      setRequesting(false);
    }
  }

  function handleSoundToggle(checked: boolean) {
    setSoundEnabled(checked);
    setSoundEnabledState(checked);
  }

  function sendTest() {
    showDesktopNotification("Test notification", "This is what a Jongo alert looks like.");
    playAlertSound();
  }

  return (
    <article className="card">
      <h3 className="card-title">Desktop Notifications</h3>
      <p className="card-muted" style={{ margin: "0.3rem 0 0.85rem", fontSize: "0.85rem" }}>
        {STATUS_COPY[permission]}
      </p>

      {permission === "default" ? (
        <button type="button" className="btn" onClick={() => void handleEnable()} disabled={requesting}>
          {requesting ? "Requesting…" : "Enable desktop notifications"}
        </button>
      ) : null}

      {permission === "granted" ? (
        <div style={{ display: "grid", gap: "0.6rem" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <input type="checkbox" checked={soundEnabled} onChange={(e) => handleSoundToggle(e.target.checked)} />
            Play a sound with new notifications
          </label>
          <div>
            <button type="button" className="btn" onClick={sendTest}>
              Send test notification
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}
