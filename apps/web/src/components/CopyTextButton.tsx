"use client";

import { useState } from "react";

type Props = {
  value: string;
  label?: string;
};

export default function CopyTextButton({ value, label = "Copy" }: Props) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");

  async function copyValue() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("copied");
      setTimeout(() => setStatus("idle"), 1200);
    } catch {
      setStatus("error");
      setTimeout(() => setStatus("idle"), 1500);
    }
  }

  return (
    <button
      type="button"
      className="button button-secondary"
      onClick={copyValue}
      style={{ padding: "0.2rem 0.5rem", fontSize: "0.74rem" }}
      aria-label={`Copy ${label}`}
    >
      {status === "copied" ? "Copied" : status === "error" ? "Error" : label}
    </button>
  );
}
