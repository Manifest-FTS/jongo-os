"use client";

import { useCallback, useEffect, useState } from "react";

export type ToastTone = "success" | "error" | "info";

export type Toast = {
  id: string;
  tone: ToastTone;
  title: string;
  text?: string;
  /** ms before auto-dismiss; 0 keeps it until dismissed. */
  ttl?: number;
};

let counter = 0;
export function newToastId(): string {
  counter += 1;
  return `t${Date.now()}-${counter}`;
}

/**
 * Minimal toast state. Kept local to the feature that uses it rather than a
 * global provider, so it cannot alter any existing page's render tree.
 */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((toast: Omit<Toast, "id">) => {
    const id = newToastId();
    setToasts((current) => [...current, { ...toast, id }]);
    return id;
  }, []);

  return { toasts, push, dismiss };
}

export function ToastStack({
  toasts,
  onDismiss,
  side = "right"
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
  side?: "left" | "right";
}) {
  if (toasts.length === 0) return null;
  return (
    <div className={`toast-stack ${side === "left" ? "toast-stack--left" : "toast-stack--right"}`} role="region" aria-label="Notifications">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const { id, ttl = 6000 } = toast;

  useEffect(() => {
    if (!ttl) return undefined;
    const timer = setTimeout(() => onDismiss(id), ttl);
    return () => clearTimeout(timer);
  }, [id, ttl, onDismiss]);

  return (
    <div
      className={`toast toast--${toast.tone}`}
      role={toast.tone === "error" ? "alert" : "status"}
      aria-live={toast.tone === "error" ? "assertive" : "polite"}
    >
      <span className="toast__dot" aria-hidden="true" />
      <div className="toast__body">
        <p className="toast__title">{toast.title}</p>
        {toast.text ? <p className="toast__text">{toast.text}</p> : null}
      </div>
      <button
        type="button"
        className="toast__close"
        onClick={() => onDismiss(id)}
        aria-label="Dismiss notification"
      >
        ✕
      </button>
    </div>
  );
}
