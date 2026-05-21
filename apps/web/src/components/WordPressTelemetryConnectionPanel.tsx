"use client";

import { useEffect, useState } from "react";

type ConnectionSummary = {
  connected: boolean;
  siteUrl: string | null;
  username: string | null;
  hasPassword: boolean;
  lastTestedAt: string | null;
  lastTestStatus: string | null;
  lastError: string | null;
};

type Props = {
  siteId: string;
};

const EMPTY_SUMMARY: ConnectionSummary = {
  connected: false,
  siteUrl: null,
  username: null,
  hasPassword: false,
  lastTestedAt: null,
  lastTestStatus: null,
  lastError: null
};

export default function WordPressTelemetryConnectionPanel({ siteId }: Props) {
  const [summary, setSummary] = useState<ConnectionSummary>(EMPTY_SUMMARY);
  const [siteUrl, setSiteUrl] = useState("");
  const [username, setUsername] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function loadSummary() {
    const response = await fetch(`/api/sites/${siteId}/wordpress-telemetry-connection`, {
      cache: "no-store"
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error ?? "Failed to load WordPress connection status");
    }

    const nextSummary = data as ConnectionSummary;
    setSummary(nextSummary);
    setSiteUrl(nextSummary.siteUrl ?? "");
    setUsername(nextSummary.username ?? "");
  }

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        await loadSummary();
      } catch (loadError) {
        if (mounted) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load connection status");
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, [siteId]);

  async function saveConnection(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await fetch(`/api/sites/${siteId}/wordpress-telemetry-connection`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ siteUrl, username, appPassword })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Failed to save WordPress connection");
      }

      setSummary(data as ConnectionSummary);
      setAppPassword("");
      setSuccess("Connection saved. Password is now hidden.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save WordPress connection");
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await fetch(`/api/sites/${siteId}/wordpress-telemetry-connection`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(appPassword.trim() ? { siteUrl, username, appPassword } : {})
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Connection test failed");
      }

      await loadSummary();
      setSuccess(`Connection test passed. Plugins discovered: ${data.pluginCount ?? 0}`);
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : "Connection test failed");
    } finally {
      setTesting(false);
    }
  }

  async function disconnect() {
    setDisconnecting(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await fetch(`/api/sites/${siteId}/wordpress-telemetry-connection`, {
        method: "DELETE"
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Failed to disconnect telemetry");
      }

      setSummary(EMPTY_SUMMARY);
      setSiteUrl("");
      setUsername("");
      setAppPassword("");
      setSuccess("Connection removed.");
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : "Failed to disconnect telemetry");
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return <p className="card-muted" style={{ marginBottom: 0 }}>Loading WordPress telemetry connection…</p>;
  }

  return (
    <div style={{ display: "grid", gap: "0.75rem" }}>
      <p style={{ margin: 0 }}>
        Status: <span className="tag">{summary.connected ? "connected" : "disconnected"}</span>
      </p>
      <form onSubmit={saveConnection} className="form-stack" style={{ marginTop: 0 }}>
        <div>
          <label className="form-label">WordPress Site URL</label>
          <input
            className="form-input"
            type="url"
            placeholder="https://example.com"
            value={siteUrl}
            onChange={(event) => {
              setSiteUrl(event.target.value);
              setSuccess(null);
            }}
            required
          />
        </div>

        <div>
          <label className="form-label">Telemetry Username</label>
          <input
            className="form-input"
            type="text"
            placeholder="wp-rest-user"
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
              setSuccess(null);
            }}
            required
          />
        </div>

        <div>
          <label className="form-label">WordPress Application Password</label>
          <input
            className="form-input mono-input"
            type="password"
            placeholder={summary.hasPassword ? "Saved (enter a new password to rotate)" : "xxxx xxxx xxxx xxxx xxxx xxxx"}
            value={appPassword}
            onChange={(event) => {
              setAppPassword(event.target.value);
              setSuccess(null);
            }}
            required={!summary.hasPassword}
          />
        </div>

        {error ? <p className="form-error">{error}</p> : null}
        {success ? <p className="form-success">{success}</p> : null}

        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button type="submit" className="btn" disabled={saving || testing || disconnecting}>
            {saving ? "Saving…" : "Save Connection"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={testConnection} disabled={saving || testing || disconnecting}>
            {testing ? "Testing…" : "Test Connection"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={disconnect}
            disabled={!summary.connected || saving || testing || disconnecting}
          >
            {disconnecting ? "Disconnecting…" : "Disconnect"}
          </button>
        </div>
      </form>

      <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)" }}>
        Last test: {summary.lastTestedAt ? new Date(summary.lastTestedAt).toLocaleString() : "not tested yet"}
      </p>
      {summary.lastTestStatus ? (
        <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)" }}>
          Last result: {summary.lastTestStatus}
          {summary.lastError ? ` (${summary.lastError})` : ""}
        </p>
      ) : null}
    </div>
  );
}
