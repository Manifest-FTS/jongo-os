"use client";

import { useMemo, useState } from "react";
import { showSuccessToast } from "@/lib/ui/toast";

type Props = {
  isWordPress: boolean;
  canToggle: boolean;
  isCollaboratorView: boolean;
};

const PASSWORD_ADJECTIVES = [
  "practical",
  "quiet",
  "silver",
  "bright",
  "steady",
  "gentle",
  "rapid",
  "simple",
  "modern",
  "calm"
];

const PASSWORD_NOUNS = [
  "lighthouse",
  "meadow",
  "harbor",
  "compass",
  "sunrise",
  "forest",
  "falcon",
  "canyon",
  "river",
  "horizon"
];

function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function generatePrivacyPassword(): string {
  return `${pickRandom(PASSWORD_ADJECTIVES)}${pickRandom(PASSWORD_NOUNS)}`.toLowerCase();
}

export default function SitePrivacyModeControl({ isWordPress, canToggle, isCollaboratorView }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [username, setUsername] = useState("jongo");
  const [password, setPassword] = useState("");

  const detail = useMemo(() => {
    if (!isWordPress) {
      return "Privacy mode is currently only available for WordPress sites.";
    }

    if (enabled) {
      return "This site is in privacy mode, which means visitors and search engines will not be able to discover your content without entering the password. Ready for the world to see your site? Feel free to turn off privacy mode at any time.";
    }

    return "This site is not in privacy mode, which means visitors and search engines can discover your content. Need to make changes before everyone sees them? Turn on privacy mode at any time.";
  }, [enabled, isWordPress]);

  const disabled = !isWordPress || !canToggle;

  function onTogglePrivacyMode() {
    if (disabled) {
      return;
    }

    const nextEnabled = !enabled;
    setEnabled(nextEnabled);

    if (nextEnabled) {
      setUsername("jongo");
      setPassword(generatePrivacyPassword());
    }
  }

  function onUpdateCredentials() {
    if (!enabled) {
      return;
    }

    showSuccessToast("Privacy credentials updated.");
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
        <h3 className="card-title" style={{ margin: 0 }}>Privacy Mode</h3>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Toggle privacy mode"
          onClick={onTogglePrivacyMode}
          disabled={disabled}
          style={{
            width: "52px",
            height: "30px",
            borderRadius: "999px",
            border: "1px solid var(--border)",
            background: enabled ? "rgba(var(--privacy-green-rgb), 0.18)" : "var(--surface)",
            display: "inline-flex",
            alignItems: "center",
            padding: "0 4px",
            justifyContent: enabled ? "flex-end" : "flex-start",
            cursor: disabled ? "not-allowed" : "pointer"
          }}
          title={disabled ? "Privacy mode toggle is unavailable for this site." : "Toggle privacy mode"}
        >
          <span
            aria-hidden
            style={{
              width: "20px",
              height: "20px",
              borderRadius: "999px",
              background: enabled ? "var(--privacy-green)" : "#cbd5e1",
              transition: "all 160ms ease"
            }}
          />
        </button>
      </div>

      <p style={{ margin: "0.7rem 0 0", fontSize: "0.9rem", color: "var(--muted)" }}>
        {detail}
      </p>

      {enabled ? (
        <div style={{ marginTop: "0.95rem", paddingTop: "0.95rem", borderTop: "1px solid var(--border)" }}>
          <div style={{ display: "grid", gap: "0.8rem" }}>
            <label style={{ display: "grid", gap: "0.35rem" }}>
              <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>Username</span>
              <input
                className="form-input"
                value={username}
                onChange={(event) => setUsername(event.target.value.toLowerCase().replace(/\s+/g, ""))}
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
              />
            </label>

            <label style={{ display: "grid", gap: "0.35rem" }}>
              <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>Current Password</span>
              <input
                className="form-input"
                value={password}
                onChange={(event) => setPassword(event.target.value.toLowerCase().replace(/\s+/g, ""))}
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
              />
            </label>

            <div>
              <button
                type="button"
                className="btn"
                onClick={onUpdateCredentials}
                disabled={disabled || !username || !password}
              >
                Update
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
