export default function NotFound() {
  return (
    <div style={{ padding: "2rem", textAlign: "center" }}>
      <h1>404 — Page not found</h1>
      <p>
        <a href="/dashboard" style={{ color: "var(--accent)" }}>
          Return to Dashboard
        </a>
      </p>
    </div>
  );
}
