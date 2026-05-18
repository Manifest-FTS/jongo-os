"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  clientId: string;
  initial: {
    name: string;
    summary?: string;
  };
};

export default function ClientInfoForm({ clientId, initial }: Props) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.summary ?? "");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setLoading(true);

    try {
      const res = await fetch(`/api/organizations/${clientId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined
        })
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Failed to save changes");
        return;
      }

      setSuccess(true);
      router.refresh();
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="form-stack">
      <div>
        <label className="form-label">
          Name <span style={{ color: "var(--error, #e55)" }}>*</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => { setName(e.target.value); setSuccess(false); }}
          required
          className="form-input"
        />
      </div>
      <div>
        <label className="form-label">Profile Notes / Summary</label>
        <input
          type="text"
          value={description}
          onChange={(e) => { setDescription(e.target.value); setSuccess(false); }}
          placeholder="Brief profile or operational context"
          className="form-input"
        />
      </div>
      {error && <p className="form-error">{error}</p>}
      {success && <p className="form-success">Saved successfully</p>}
      <button type="submit" className="btn" disabled={loading}>
        {loading ? "Saving…" : "Save Changes"}
      </button>
    </form>
  );
}
