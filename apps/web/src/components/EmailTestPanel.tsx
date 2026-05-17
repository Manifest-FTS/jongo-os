"use client";

import { useState } from "react";

export default function EmailTestPanel() {
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function sendTestEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);

    try {
      const res = await fetch("/api/admin/email/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: to.trim() || undefined })
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Failed to send test email");
        return;
      }

      setNotice(`Test email sent via ${data.provider}.`);
      setTo("");
    } catch {
      setError("Network error while sending test email");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={sendTestEmail} style={{ marginTop: "0.8rem" }}>
      <p className="card-muted" style={{ margin: "0 0 0.4rem" }}>
        Send test email (admin/dev only)
      </p>
      <div className="form-row">
        <input
          className="form-input"
          type="email"
          placeholder="recipient@example.com (optional)"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="btn" disabled={busy}>
          {busy ? "Sending..." : "Send test email"}
        </button>
      </div>
      {notice ? <p className="form-help" style={{ marginTop: "0.45rem" }}>{notice}</p> : null}
      {error ? <p className="form-error" style={{ marginTop: "0.45rem" }}>{error}</p> : null}
    </form>
  );
}
