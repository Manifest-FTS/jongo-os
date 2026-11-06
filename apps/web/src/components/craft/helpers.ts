/** Pure helpers for the Craft panel; kept free of React so they can be tested directly. */

/** One URI per line; blank lines dropped. Validation stays on the server, which is the only authority. */
export function splitUriLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

/** Stable (timezone independent) so server and client render the same text. */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  return Number.isNaN(time) ? "" : new Date(time).toISOString().slice(0, 10);
}

export function personLabel(person: { name: string | null; email: string | null }): string {
  return person.name?.trim() || person.email || "Unknown";
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

/** Same-origin JSON call; never throws and never surfaces more than the server's own error text. */
export async function callJson<T>(url: string, init: { method: string; body?: unknown } = { method: "GET" }): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method: init.method,
      cache: "no-store",
      headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, error: typeof (data as { error?: unknown }).error === "string" ? (data as { error: string }).error : "Request failed" };
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, status: 0, error: "Network error. Please try again." };
  }
}
