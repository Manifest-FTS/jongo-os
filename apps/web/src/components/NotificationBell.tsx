"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { BellIcon } from "@/components/JongoIcons";
import { playAlertSound, showDesktopNotification } from "@/lib/desktop-notifications";

type NotificationRow = {
  id: string;
  type: string;
  title: string;
  message: string;
  readAt: string | null;
  createdAt: string;
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Ids already seen, so a desktop alert only fires for what is genuinely new
  // since the last poll -- not for the whole list every 60 seconds, and not
  // for anything already unread on the very first load of a session.
  const seenIdsRef = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications?limit=5", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      const notifications = (data as { notifications?: NotificationRow[] }).notifications ?? [];

      if (seenIdsRef.current) {
        const unseen = notifications.filter((n) => !n.readAt && !seenIdsRef.current!.has(n.id));
        for (const n of unseen) {
          showDesktopNotification(n.title, n.message);
        }
        if (unseen.length > 0) playAlertSound();
      }
      seenIdsRef.current = new Set(notifications.map((n) => n.id));

      setRows(notifications);
      setUnreadCount((data as { unreadCount?: number }).unreadCount ?? 0);
    } catch {
      // Silent: the tray simply stays at its last-known state.
    }
  }, []);

  useEffect(() => {
    void load();
    // Polling rather than a socket: the tray only needs to be "roughly live",
    // and every other piece of near-real-time state in this app (staging
    // status, deployments) already polls on a plain interval.
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  async function markRead(id: string) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, readAt: new Date().toISOString() } : r)));
    setUnreadCount((prev) => Math.max(0, prev - 1));
    try {
      await fetch(`/api/notifications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "read" })
      });
    } catch {
      void load();
    }
  }

  async function dismiss(id: string) {
    const wasUnread = rows.find((r) => r.id === id)?.readAt == null;
    setRows((prev) => prev.filter((r) => r.id !== id));
    if (wasUnread) setUnreadCount((prev) => Math.max(0, prev - 1));
    try {
      await fetch(`/api/notifications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismiss" })
      });
    } catch {
      void load();
    }
  }

  async function clearAll() {
    setRows([]);
    setUnreadCount(0);
    try {
      await fetch("/api/notifications/clear-all", { method: "POST" });
    } catch {
      void load();
    }
  }

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="topbar-icon-button"
        aria-label="Notifications"
        onClick={() => {
          setOpen((v) => !v);
          if (!open) void load();
        }}
        style={{ position: "relative" }}
      >
        <BellIcon className="topbar-icon" />
        {unreadCount > 0 ? (
          <span
            aria-label={`${unreadCount} unread notifications`}
            style={{
              position: "absolute",
              top: -2,
              right: -2,
              minWidth: "16px",
              height: "16px",
              padding: "0 4px",
              borderRadius: "999px",
              background: "#b3261e",
              color: "#fff",
              fontSize: "10px",
              fontWeight: 700,
              lineHeight: "16px",
              textAlign: "center"
            }}
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Notifications"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            width: "340px",
            maxHeight: "440px",
            overflow: "auto",
            background: "#ffffff",
            border: "1px solid var(--border)",
            borderRadius: "14px",
            boxShadow: "0 24px 60px rgba(15, 23, 42, 0.22)",
            zIndex: 80
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.75rem 0.9rem", borderBottom: "1px solid var(--border)" }}>
            <strong style={{ fontSize: "0.9rem" }}>Notifications</strong>
            {rows.length > 0 ? (
              <button type="button" className="btn" style={{ padding: "0.2rem 0.55rem", fontSize: "0.78rem" }} onClick={() => void clearAll()}>
                Clear all
              </button>
            ) : null}
          </div>

          {loading ? <p className="card-muted" style={{ padding: "0.9rem" }}>Loading…</p> : null}

          {!loading && rows.length === 0 ? (
            <p className="card-muted" style={{ padding: "0.9rem", margin: 0 }}>No notifications.</p>
          ) : null}

          {rows.map((row) => (
            <div key={row.id} style={{ padding: "0.7rem 0.9rem", borderBottom: "1px solid var(--border)", background: row.readAt ? "transparent" : "#f6faf4" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", alignItems: "flex-start" }}>
                <p style={{ margin: 0, fontWeight: 600, fontSize: "0.85rem" }}>{row.title}</p>
                <span className="card-muted" style={{ fontSize: "0.72rem", whiteSpace: "nowrap" }}>{timeAgo(row.createdAt)}</span>
              </div>
              <p style={{ margin: "0.25rem 0 0", fontSize: "0.8rem", color: "var(--muted)" }}>{row.message}</p>
              <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.4rem" }}>
                {!row.readAt ? (
                  <button type="button" className="btn" style={{ padding: "0.15rem 0.5rem", fontSize: "0.74rem" }} onClick={() => void markRead(row.id)}>
                    Mark as read
                  </button>
                ) : null}
                <button type="button" className="btn" style={{ padding: "0.15rem 0.5rem", fontSize: "0.74rem" }} onClick={() => void dismiss(row.id)}>
                  Dismiss
                </button>
              </div>
            </div>
          ))}

          <div style={{ padding: "0.6rem 0.9rem" }}>
            <Link href="/notifications" className="btn" style={{ width: "100%", textAlign: "center" }} onClick={() => setOpen(false)}>
              View all notifications
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
