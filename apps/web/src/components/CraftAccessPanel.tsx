"use client";

import { useEffect, useId, useRef, useState } from "react";
import CraftClientSection from "@/components/CraftClientSection";
import { callJson, formatDay, personLabel } from "@/components/craft/helpers";
import { CRAFT_ROLE_OPTIONS, type CraftAccessPayload, type CraftClientPayload, type CraftRoleName } from "@/lib/craft-admin/shared";

type Props = {
  siteId: string;
  /** Preloaded data (tests, screenshots); otherwise the panel fetches it. */
  initial?: { access: CraftAccessPayload; client: CraftClientPayload };
};

/** Rendered by the settings page only when JONGO_OIDC_ENABLED is "true" and the viewer may manage Craft access. */
export default function CraftAccessPanel({ siteId, initial }: Props) {
  const ids = useId();
  const base = `/api/sites/${encodeURIComponent(siteId)}/craft-access`;
  const [access, setAccess] = useState<CraftAccessPayload | null>(initial?.access ?? null);
  const [loading, setLoading] = useState(!initial);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<CraftRoleName>("editor");
  const [status, setStatus] = useState<{ message: string; isError: boolean }>({ message: "", isError: false });
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  const announce = (message: string, isError = false) => setStatus({ message, isError });

  async function load() {
    const result = await callJson<CraftAccessPayload>(base);
    if (result.ok) setAccess(result.data);
    else announce(result.error, true);
    setLoading(false);
  }

  useEffect(() => {
    if (!initial) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await callJson<{ created: boolean }>(base, { method: "POST", body: { email: email.trim(), role } });
    setBusy(false);
    if (!result.ok) { announce(result.error, true); return; }
    setEmail("");
    announce(result.data.created ? "Craft access granted." : "Craft access updated.");
    await load();
    emailRef.current?.focus();
  }

  async function changeRole(userId: string, label: string, next: CraftRoleName) {
    setBusy(true);
    const result = await callJson<{ created: boolean }>(base, { method: "POST", body: { userId, role: next } });
    setBusy(false);
    if (!result.ok) { announce(result.error, true); await load(); return; }
    announce(`${label} is now ${next}.`);
    await load();
  }

  async function revoke(userId: string, label: string) {
    setBusy(true); setConfirmRevoke(null);
    const result = await callJson<{ ok: true }>(`${base}/${encodeURIComponent(userId)}`, { method: "DELETE" });
    setBusy(false);
    if (!result.ok) { announce(result.error, true); return; }
    announce(`Craft access revoked for ${label}.`);
    await load();
    emailRef.current?.focus();
  }

  return (
    <article className="card craft-panel" aria-labelledby={`${ids}-title`}>
      <h3 id={`${ids}-title`} className="card-title">Jongo Craft</h3>
      <p className="card-muted">
        Choose who can sign in to this app&apos;s Craft studio with their Jongo account. Only the client owner and admins can change this.
      </p>

      <p role="status" aria-live="polite" className={status.isError ? "form-error" : "form-success"}>{status.message}</p>

      <h4 className="craft-subheading">Who can sign in</h4>
      {loading ? <p className="card-muted">Loading…</p> : null}
      {access ? (
        <>
          <table className="craft-table">
            <caption className="craft-caption">People with Craft access to this app</caption>
            <thead>
              <tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Granted</th><th scope="col"><span className="craft-visually-hidden">Actions</span></th></tr>
            </thead>
            <tbody>
              {access.inherited.map((row) => (
                <tr key={`${row.source}-${row.userId ?? "platform"}`} className="craft-row--inherited">
                  <td>
                    <strong>{row.userId ? personLabel(row) : row.label}</strong>
                    {row.userId ? <span className="card-muted craft-block">{row.email}</span> : null}
                    {row.contacts && row.contacts.length > 0 ? <span className="card-muted craft-block">Jongo staff: {row.contacts.join(", ")}</span> : null}
                  </td>
                  <td><span className="tag">admin</span></td>
                  <td colSpan={2}><span className="card-muted">{row.userId ? row.label : "Implicit admin access for Jongo support; every sign-in is audited"}. Read-only here.</span></td>
                </tr>
              ))}
              {access.explicit.map((row) => {
                const label = personLabel(row);
                return (
                  <tr key={row.userId}>
                    <td><strong>{label}</strong><span className="card-muted craft-block">{row.email}</span></td>
                    <td>
                      <select
                        className="form-select" value={row.role} disabled={busy} aria-label={`Craft role for ${label}`}
                        onChange={(event) => void changeRole(row.userId, label, event.target.value as CraftRoleName)}
                      >
                        {CRAFT_ROLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </td>
                    <td className="card-muted">
                      {formatDay(row.updatedAt)}{row.grantedBy ? ` by ${personLabel({ name: row.grantedBy.name, email: row.grantedBy.email })}` : ""}
                    </td>
                    <td>
                      {confirmRevoke === row.userId ? (
                        <span role="group" aria-label={`Confirm revoking ${label}`} className="craft-confirm">
                          <button type="button" className="btn btn-danger craft-small" onClick={() => void revoke(row.userId, label)} disabled={busy}>Confirm revoke</button>
                          <button type="button" className="btn craft-small" onClick={() => setConfirmRevoke(null)}>Cancel</button>
                        </span>
                      ) : (
                        <button type="button" className="btn btn-danger craft-small" onClick={() => setConfirmRevoke(row.userId)} disabled={busy} aria-label={`Revoke Craft access for ${label}`}>Revoke</button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {access.explicit.length === 0 ? (
                <tr><td colSpan={4} className="card-muted">No one has been given explicit access yet.</td></tr>
              ) : null}
            </tbody>
          </table>

          <form onSubmit={add} className="craft-add" aria-label="Add a person to Jongo Craft">
            <div className="craft-add__email">
              <label className="form-label" htmlFor={`${ids}-email`}>Add a person by email</label>
              <input
                id={`${ids}-email`} ref={emailRef} className="form-input" type="email" required maxLength={254} autoComplete="off"
                placeholder="person@example.com" value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy}
                aria-describedby={`${ids}-add-help`}
              />
            </div>
            <div>
              <label className="form-label" htmlFor={`${ids}-role`}>Role</label>
              <select id={`${ids}-role`} className="form-select" value={role} onChange={(event) => setRole(event.target.value as CraftRoleName)} disabled={busy}>
                {CRAFT_ROLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
            <div><button type="submit" className="btn btn--primary" disabled={busy}>Add</button></div>
            <p id={`${ids}-add-help`} className="form-help craft-add__help">
              They need a Jongo account already. To invite someone new, invite them to the app and pick a Craft role there.
            </p>
          </form>
        </>
      ) : null}

      <CraftClientSection siteId={siteId} initial={initial?.client} onStatus={announce} />
    </article>
  );
}
