"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  open: boolean;
  title: string;
  body: string;
  /** Red callout for what is irreversible or disruptive. */
  warning?: string;
  /** When set, the confirm button stays disabled until the user types this exactly. */
  confirmPhrase?: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Confirmation dialog for destructive actions — replaces window.confirm().
 * Requiring the user to type an exact phrase makes a misfire effectively
 * impossible, which matters for actions that overwrite live data.
 */
export default function ConfirmDialog({
  open,
  title,
  body,
  warning,
  confirmPhrase,
  confirmLabel = "Confirm",
  busy = false,
  onConfirm,
  onCancel
}: Props) {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setTyped("");
      // Focus the phrase input (or the dialog) once it renders.
      const id = setTimeout(() => {
        if (inputRef.current) inputRef.current.focus();
        else dialogRef.current?.focus();
      }, 0);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const satisfied = !confirmPhrase || typed.trim() === confirmPhrase;

  return (
    <div
      className="cd-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        className="cd-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cd-title"
        aria-describedby="cd-body"
        tabIndex={-1}
        ref={dialogRef}
      >
        <h2 className="cd-title" id="cd-title">{title}</h2>
        <p className="cd-body" id="cd-body">{body}</p>
        {warning ? <p className="cd-warn">{warning}</p> : null}

        {confirmPhrase ? (
          <>
            <label className="cd-label" htmlFor="cd-phrase">
              Type <strong>{confirmPhrase}</strong> to continue
            </label>
            <input
              id="cd-phrase"
              className="cd-input"
              ref={inputRef}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onKeyDown={(event) => {
                if (event.key === "Enter" && satisfied && !busy) onConfirm();
              }}
            />
          </>
        ) : null}

        <div className="cd-actions">
          <button type="button" className="button button-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="button cd-confirm"
            onClick={onConfirm}
            disabled={busy || !satisfied}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
