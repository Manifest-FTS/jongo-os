"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import UserAvatar from "@/components/UserAvatar";
import { getInitials } from "@/lib/profile";

type Props = {
  initial: {
    email: string;
    firstName: string;
    lastName: string;
    username: string;
    profileRole: string;
    imageUrl?: string | null;
  };
};

export default function ProfileSettingsForm({ initial }: Props) {
  const router = useRouter();
  const [email, setEmail] = useState(initial.email);
  const [firstName, setFirstName] = useState(initial.firstName);
  const [lastName, setLastName] = useState(initial.lastName);
  const [username, setUsername] = useState(initial.username);
  const [profileRole, setProfileRole] = useState(initial.profileRole);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(false);
    setLoading(true);

    try {
      const res = await fetch("/api/user/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          firstName,
          lastName,
          username,
          profileRole
        })
      });

      const data = await res.json().catch(() => ({}));
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

  const initials = getInitials(`${firstName} ${lastName}`.trim(), email);

  return (
    <form onSubmit={handleSubmit} className="form-stack">
      <div style={{ display: "grid", gridTemplateColumns: "140px minmax(0, 1fr)", gap: "1.25rem", alignItems: "start" }}>
        <div style={{ display: "grid", justifyItems: "center", gap: "0.65rem" }}>
          <UserAvatar
            imageUrl={initial.imageUrl}
            initials={initials}
            alt="Profile avatar"
            title="Gravatar if available, otherwise your initials"
            size={84}
          />
        </div>

        <div style={{ display: "grid", gap: "0.9rem" }}>
          <div>
            <label className="form-label">Username</label>
            <input
              type="text"
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                setSuccess(false);
              }}
              placeholder="kevinwilliams"
              className="form-input"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>

          <div>
            <label className="form-label">Role</label>
            <input
              type="text"
              value={profileRole}
              onChange={(event) => {
                setProfileRole(event.target.value);
                setSuccess(false);
              }}
              placeholder="Founder"
              className="form-input"
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "0.85rem" }}>
            <div>
              <label className="form-label">First name</label>
              <input
                type="text"
                value={firstName}
                onChange={(event) => {
                  setFirstName(event.target.value);
                  setSuccess(false);
                }}
                className="form-input"
              />
            </div>

            <div>
              <label className="form-label">Last name</label>
              <input
                type="text"
                value={lastName}
                onChange={(event) => {
                  setLastName(event.target.value);
                  setSuccess(false);
                }}
                className="form-input"
              />
            </div>
          </div>

          <div>
            <label className="form-label">Email address</label>
            <input
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setSuccess(false);
              }}
              className="form-input"
              required
            />
          </div>
        </div>
      </div>

      {error ? <p className="form-error">{error}</p> : null}
      {success ? <p className="form-success">Saved successfully</p> : null}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="submit" className="btn" disabled={loading} style={{ width: "min(100%, 9rem)" }}>
          {loading ? "Saving..." : "Save changes"}
        </button>
      </div>
    </form>
  );
}
