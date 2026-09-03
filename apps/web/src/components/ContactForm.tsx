"use client";

import { useState } from "react";

/**
 * The contact form.
 *
 * Reports only what the server confirmed: on anything other than a successful
 * send it shows the API's own message rather than a cheerful one of its own.
 * The hidden "website" field is a honeypot — a person never sees it, so a
 * value in it means a bot filled the form.
 */

type Props = {
  /** Same address api/contact delivers to. Empty when none is configured. */
  contactEmail: string;
  responseTime: string;
};

type Status = { kind: "idle" } | { kind: "sending" } | { kind: "sent"; message: string } | { kind: "error"; message: string };

export default function ContactForm({ contactEmail, responseTime }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [form, setForm] = useState({ name: "", email: "", company: "", message: "", website: "" });

  function update(field: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus({ kind: "sending" });

    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form)
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload?.ok) {
        setStatus({ kind: "error", message: payload?.message ?? "That did not send. Please try again." });
        return;
      }

      setStatus({ kind: "sent", message: payload.message ?? "Thanks — we will be in touch." });
      setForm({ name: "", email: "", company: "", message: "", website: "" });
    } catch {
      setStatus({ kind: "error", message: "That did not send — the request did not complete." });
    }
  }

  if (status.kind === "sent") {
    return (
      <div className="contact-sent" role="status">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#4a7a35" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="m8.4 12.2 2.4 2.4 4.8-5" />
        </svg>
        <h3>Message sent</h3>
        <p>{status.message}</p>
        <button type="button" className="btn btn-secondary" onClick={() => setStatus({ kind: "idle" })}>
          Send another
        </button>
      </div>
    );
  }

  const busy = status.kind === "sending";

  return (
    <form onSubmit={onSubmit} className="contact-form">
      <div className="contact-form__row">
        <div className="auth-field">
          <label htmlFor="contact-name">Your name</label>
          <input
            id="contact-name"
            className="form-input"
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            required
            maxLength={120}
            autoComplete="name"
            disabled={busy}
          />
        </div>
        <div className="auth-field">
          <label htmlFor="contact-email">Email</label>
          <input
            id="contact-email"
            type="email"
            className="form-input"
            value={form.email}
            onChange={(e) => update("email", e.target.value)}
            required
            maxLength={200}
            autoComplete="email"
            disabled={busy}
          />
        </div>
      </div>

      <div className="auth-field">
        <label htmlFor="contact-company">Company or agency <span className="contact-optional">optional</span></label>
        <input
          id="contact-company"
          className="form-input"
          value={form.company}
          onChange={(e) => update("company", e.target.value)}
          maxLength={160}
          autoComplete="organization"
          disabled={busy}
        />
      </div>

      <div className="auth-field">
        <label htmlFor="contact-message">How can we help?</label>
        <textarea
          id="contact-message"
          className="form-input contact-textarea"
          value={form.message}
          onChange={(e) => update("message", e.target.value)}
          required
          maxLength={4000}
          rows={6}
          placeholder="How many sites, what they are built with, and where they are hosted now."
          disabled={busy}
        />
      </div>

      {/* Honeypot. Hidden from people and from screen readers; bots fill it. */}
      <div className="contact-honeypot" aria-hidden>
        <label htmlFor="contact-website">Website</label>
        <input
          id="contact-website"
          tabIndex={-1}
          autoComplete="off"
          value={form.website}
          onChange={(e) => update("website", e.target.value)}
        />
      </div>

      {status.kind === "error" ? (
        <p className="form-error" role="alert" style={{ margin: 0 }}>
          {status.message}
        </p>
      ) : null}

      <button type="submit" className="btn" disabled={busy}>
        {busy ? "Sending…" : "Send message"}
      </button>
      <p className="contact-fineprint">
        We reply to everything, usually within {responseTime}.
        {contactEmail ? (
          <>
            {" "}
            Prefer email? Write to <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.
          </>
        ) : null}
      </p>
    </form>
  );
}
