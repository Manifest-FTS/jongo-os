"use client";

import { useCallback, useEffect, useState } from "react";
import { postWithProgress } from "@/components/CreationProgress";
import { showSuccessToast } from "@/lib/ui/toast";

type SetupState = {
  state: "pending" | "running" | "installed" | "already_installed" | "failed" | null;
  problem: string | null;
  adminUser: string | null;
  adminEmail: string | null;
  loginUrl: string | null;
  password: string | null;
  passwordUnreadable: boolean;
};

/**
 * The WordPress admin login for a site Jongo created, and "Finish setup" when
 * the automatic setup didn't complete. Renders nothing for linked sites.
 */
export default function WordPressSetupCard({ siteId }: { siteId: string }) {
  const [data, setData] = useState<SetupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sites/${siteId}/wordpress-setup`, { cache: "no-store" });
      if (res.ok) setData(await res.json());
    } catch {
      /* the card simply stays hidden */
    }
  }, [siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Another tab or the creation request is still installing: check back.
  useEffect(() => {
    if (data?.state !== "running" && data?.state !== "pending") return;
    const timer = setTimeout(() => void load(), 8000);
    return () => clearTimeout(timer);
  }, [data, load]);

  if (!data?.state) return null;
  // Set up and the password already acknowledged: nothing left to show.
  if (data.state === "installed" && !data.password && !data.passwordUnreadable) {
    return data.loginUrl ? (
      <article className="card">
        <h3 className="card-title" style={{ marginBottom: "0.35rem" }}>WordPress admin</h3>
        <p className="card-muted" style={{ marginTop: 0 }}>
          Sign in as <strong>{data.adminUser}</strong>. Forgot the password? Use "Lost your password?" on the login page.
        </p>
        <a className="btn btn-secondary" href={data.loginUrl} target="_blank" rel="noreferrer">Open WordPress admin</a>
      </article>
    ) : null;
  }

  async function finish() {
    setBusy(true);
    setMessage(null);
    try {
      const { status, body } = await postWithProgress(`/api/sites/${siteId}/wordpress-setup`, {}, () => undefined);
      setMessage(body?.message ?? (status < 400 ? "WordPress is set up." : "Setup didn't finish."));
      if (status < 400) setData(body);
      else await load();
    } catch {
      setMessage("Couldn't reach Jongo. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function forget() {
    setBusy(true);
    try {
      const res = await fetch(`/api/sites/${siteId}/wordpress-setup`, { method: "DELETE" });
      if (res.ok) {
        setData(await res.json());
        showSuccessToast("Got it. Jongo no longer keeps this password.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      showSuccessToast("Copied.");
    } catch {
      setMessage("Couldn't copy. Select the text and copy it by hand.");
    }
  }

  return (
    <article className="card">
      <h3 className="card-title" style={{ marginBottom: "0.35rem" }}>WordPress admin</h3>

      {data.state === "running" || data.state === "pending" ? (
        <p className="card-muted" style={{ margin: 0 }}>
          <span className="loader__spinner" style={{ width: 12, height: 12, display: "inline-block", marginRight: 6, verticalAlign: "-1px" }} aria-hidden="true" />
          Setting up WordPress. This usually takes a minute or two.
        </p>
      ) : null}

      {data.state === "failed" ? (
        <div style={{ display: "grid", gap: "0.6rem" }}>
          <p className="card-muted" style={{ margin: 0 }}>{data.problem ?? "WordPress setup didn't finish."}</p>
          <button type="button" className="btn" disabled={busy} onClick={finish} style={{ justifySelf: "start" }}>
            {busy ? "Setting up…" : "Finish setup"}
          </button>
        </div>
      ) : null}

      {data.state === "already_installed" ? (
        <p className="card-muted" style={{ margin: 0 }}>
          WordPress was set up before Jongo could finish it. Check Users in WordPress and remove any account you don't recognise.
        </p>
      ) : null}

      {data.state === "installed" ? (
        <div style={{ display: "grid", gap: "0.55rem" }}>
          <div>
            <p className="card-muted" style={{ margin: 0, fontSize: "0.8rem" }}>Username</p>
            <p style={{ margin: 0, fontWeight: 600 }}>{data.adminUser}</p>
          </div>
          {data.password ? (
            <div>
              <p className="card-muted" style={{ margin: 0, fontSize: "0.8rem" }}>Password</p>
              <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
                <code style={{ fontSize: "0.9rem", wordBreak: "break-all" }}>{reveal ? data.password : "••••••••••••"}</code>
                <button type="button" className="button button-secondary" onClick={() => setReveal(!reveal)}>{reveal ? "Hide" : "Show"}</button>
                <button type="button" className="button button-secondary" onClick={() => copy(data.password!)}>Copy</button>
              </div>
            </div>
          ) : null}
          {data.passwordUnreadable ? (
            <p className="card-muted" style={{ margin: 0 }}>The saved password can't be shown. Use "Lost your password?" on the login page.</p>
          ) : null}
          <p className="card-muted" style={{ margin: 0, fontSize: "0.85rem" }}>
            Save this password in your password manager. Jongo forgets it once you confirm.
          </p>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {data.loginUrl ? (
              <a className="btn btn-secondary" href={data.loginUrl} target="_blank" rel="noreferrer">Open WordPress admin</a>
            ) : null}
            <button type="button" className="btn" disabled={busy} onClick={forget}>I've saved it</button>
          </div>
        </div>
      ) : null}

      {message ? <p className="card-muted" style={{ marginBottom: 0 }}>{message}</p> : null}
    </article>
  );
}
