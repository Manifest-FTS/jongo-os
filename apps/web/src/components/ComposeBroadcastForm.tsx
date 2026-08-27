"use client";

import { useEffect, useMemo, useState } from "react";

type RecipientClient = { id: string; name: string; apps: Array<{ id: string; name: string }> };
type RecipientMember = { id: string; email: string; fullName: string | null; clientName: string };
type Template = { id: string; templateKey: string; subject: string; bodyTemplate: string };

type Scope = "all" | "clients" | "apps" | "members";
type DeliveryMode = "in_app" | "email" | "in_app_and_email";

export default function ComposeBroadcastForm() {
  const [clients, setClients] = useState<RecipientClient[]>([]);
  const [members, setMembers] = useState<RecipientMember[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);

  const [scope, setScope] = useState<Scope>("all");
  const [selectedClientIds, setSelectedClientIds] = useState<string[]>([]);
  const [selectedSiteIds, setSelectedSiteIds] = useState<string[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);

  const [templateKey, setTemplateKey] = useState<string>("custom_announcement");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [actionLink, setActionLink] = useState("");
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("in_app_and_email");

  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [recipientsRes, templatesRes] = await Promise.all([
          fetch("/api/notifications/recipients", { cache: "no-store" }),
          fetch("/api/notifications/templates", { cache: "no-store" })
        ]);
        const recipientsData = await recipientsRes.json().catch(() => ({}));
        const templatesData = await templatesRes.json().catch(() => ({}));
        if (cancelled) return;
        setClients((recipientsData as { clients?: RecipientClient[] }).clients ?? []);
        setMembers((recipientsData as { members?: RecipientMember[] }).members ?? []);
        setTemplates((templatesData as { templates?: Template[] }).templates ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const allApps = useMemo(
    () => clients.flatMap((c) => c.apps.map((a) => ({ ...a, clientName: c.name }))),
    [clients]
  );

  function applyTemplate(key: string) {
    setTemplateKey(key);
    const template = templates.find((t) => t.templateKey === key);
    if (template) {
      setSubject(template.subject);
      setMessage(template.bodyTemplate);
    } else if (key === "custom_announcement") {
      setSubject("");
      setMessage("");
    }
  }

  function toggleId(list: string[], id: string, setList: (v: string[]) => void) {
    setList(list.includes(id) ? list.filter((v) => v !== id) : [...list, id]);
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setResult(null);
    try {
      const res = await fetch("/api/notifications/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope,
          clientIds: selectedClientIds,
          siteIds: selectedSiteIds,
          userIds: selectedUserIds,
          templateKey,
          subject,
          message,
          deliveryMode,
          actionLink: actionLink || undefined
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResult({ ok: false, text: (data as { error?: string; message?: string }).error ?? (data as any).message ?? "Failed to send broadcast" });
        return;
      }
      setResult({
        ok: true,
        text: `Sent to ${(data as any).recipientCount} recipient${(data as any).recipientCount === 1 ? "" : "s"}${
          deliveryMode !== "in_app" ? ` (${(data as any).emailSentCount} emails delivered)` : ""
        }.`
      });
      setSubject("");
      setMessage("");
      setActionLink("");
    } catch {
      setResult({ ok: false, text: "Network error while sending broadcast" });
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <article className="card">
        <p className="card-muted">Loading recipients…</p>
      </article>
    );
  }

  return (
    <form onSubmit={handleSend} className="card" style={{ display: "grid", gap: "1.1rem" }}>
      <div>
        <h3 className="card-title">Recipients</h3>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
          {(["all", "clients", "apps", "members"] as Scope[]).map((s) => (
            <button
              key={s}
              type="button"
              className={`tab-link${scope === s ? " is-active" : ""}`}
              onClick={() => setScope(s)}
            >
              {s === "all" ? "All Clients / Collaborators" : s === "clients" ? "Specific Client(s)" : s === "apps" ? "Specific App(s)" : "Specific Team Member(s)"}
            </button>
          ))}
        </div>

        {scope === "clients" ? (
          <div style={{ display: "grid", gap: "0.35rem", marginTop: "0.75rem", maxHeight: "220px", overflow: "auto" }}>
            {clients.map((c) => (
              <label key={c.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <input
                  type="checkbox"
                  checked={selectedClientIds.includes(c.id)}
                  onChange={() => toggleId(selectedClientIds, c.id, setSelectedClientIds)}
                />
                {c.name}
              </label>
            ))}
          </div>
        ) : null}

        {scope === "apps" ? (
          <div style={{ display: "grid", gap: "0.35rem", marginTop: "0.75rem", maxHeight: "220px", overflow: "auto" }}>
            {allApps.map((a) => (
              <label key={a.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <input
                  type="checkbox"
                  checked={selectedSiteIds.includes(a.id)}
                  onChange={() => toggleId(selectedSiteIds, a.id, setSelectedSiteIds)}
                />
                {a.name} <span className="card-muted">({a.clientName})</span>
              </label>
            ))}
          </div>
        ) : null}

        {scope === "members" ? (
          <div style={{ display: "grid", gap: "0.35rem", marginTop: "0.75rem", maxHeight: "220px", overflow: "auto" }}>
            {members.map((m) => (
              <label key={m.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <input
                  type="checkbox"
                  checked={selectedUserIds.includes(m.id)}
                  onChange={() => toggleId(selectedUserIds, m.id, setSelectedUserIds)}
                />
                {m.fullName || m.email} <span className="card-muted">({m.clientName})</span>
              </label>
            ))}
          </div>
        ) : null}
      </div>

      <div>
        <h3 className="card-title">Template</h3>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
          <button type="button" className={`tab-link${templateKey === "suspension_notice" ? " is-active" : ""}`} onClick={() => applyTemplate("suspension_notice")}>
            Suspension Notice
          </button>
          <button type="button" className={`tab-link${templateKey === "maintenance_notice" ? " is-active" : ""}`} onClick={() => applyTemplate("maintenance_notice")}>
            Maintenance Notice
          </button>
          <button type="button" className={`tab-link${templateKey === "custom_announcement" ? " is-active" : ""}`} onClick={() => applyTemplate("custom_announcement")}>
            Custom Alert
          </button>
        </div>
        <p className="card-muted" style={{ marginTop: "0.5rem", fontSize: "0.82rem" }}>
          Use <code>{"{{client_name}}"}</code>, <code>{"{{app_name}}"}</code> and <code>{"{{action_link}}"}</code> — each is filled in per recipient.
        </p>
      </div>

      <label style={{ display: "grid", gap: "0.35rem" }}>
        <span>Subject</span>
        <input
          type="text"
          className="form-input"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          required
          maxLength={200}
        />
      </label>

      <label style={{ display: "grid", gap: "0.35rem" }}>
        <span>Message</span>
        <textarea
          className="form-input"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={6}
          required
        />
      </label>

      <label style={{ display: "grid", gap: "0.35rem" }}>
        <span>Action link (optional — fills {"{{action_link}}"})</span>
        <input type="url" className="form-input" value={actionLink} onChange={(e) => setActionLink(e.target.value)} placeholder="https://..." />
      </label>

      <div>
        <h3 className="card-title">Delivery Mode</h3>
        <div style={{ display: "flex", gap: "1rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
          {(["in_app", "email", "in_app_and_email"] as DeliveryMode[]).map((mode) => (
            <label key={mode} style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <input type="radio" name="deliveryMode" checked={deliveryMode === mode} onChange={() => setDeliveryMode(mode)} />
              {mode === "in_app" ? "In-App Only" : mode === "email" ? "Email Only" : "In-App + Branded Email"}
            </label>
          ))}
        </div>
      </div>

      {result ? (
        <p className={result.ok ? "card-muted" : "form-error"}>{result.text}</p>
      ) : null}

      <div>
        <button type="submit" className="btn" disabled={sending}>
          {sending ? "Sending…" : "Send Broadcast"}
        </button>
      </div>
    </form>
  );
}
