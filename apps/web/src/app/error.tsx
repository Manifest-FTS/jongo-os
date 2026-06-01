"use client";

import { useEffect } from "react";

type Props = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function Error({ error, reset }: Props) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div style={{ padding: "2rem", textAlign: "center" }}>
      <h1>Something went wrong</h1>
      <p style={{ color: "var(--muted)" }}>
        Jongo hit an unexpected error while loading this page.
      </p>
      <button type="button" className="btn btn-secondary" onClick={() => reset()}>
        Try again
      </button>
    </div>
  );
}