/**
 * How detached jobs (backup, restore, rehearsal, verification) report their
 * result to the Jongo app. They run inside the app's own container, so the app
 * on 127.0.0.1 comes first: a public address can move or break (the old
 * jongo.manifest-fts.com started answering 503, and every backup result was
 * lost while the backups themselves succeeded). Public addresses stay as
 * fallbacks for jobs run elsewhere.
 */

export function appBaseCandidates(env = process.env) {
  const values = [
    `http://127.0.0.1:${(env.PORT || "3000").trim()}`,
    env.APP_BASE_URL,
    env.NEXTAUTH_URL
  ];
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const base = String(value || "").trim().replace(/\/+$/, "");
    if (!base || seen.has(base)) continue;
    seen.add(base);
    out.push(base);
  }
  return out;
}

function opsToken(env) {
  for (const key of ["BACKUP_RECONCILE_TOKEN", "OWNERSHIP_SYNC_TOKEN"]) {
    const value = String(env[key] || "").trim();
    if (value) return value;
  }
  return "";
}

/**
 * POSTs to the first address that answers. A 5xx, a redirect or a network
 * error moves on to the next one; any other status is the app's real answer and is returned.
 */
export async function postToApp(path, payload, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const token = opsToken(env);
  if (!token) return { ok: false, status: 0, base: null, error: "no ops token" };
  let last = { ok: false, status: 0, base: null, error: "no address" };
  for (const base of appBaseCandidates(env)) {
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs)
      });
      // 5xx, or a redirect (login page / another host): not the app's answer.
      if (res.status >= 500 || res.status === 0 || (res.status >= 300 && res.status < 400)) {
        last = { ok: false, status: res.status, base };
        continue;
      }
      return { ok: res.status >= 200 && res.status < 300, status: res.status, base };
    } catch (error) {
      last = { ok: false, status: 0, base, error: error instanceof Error ? error.message : "unknown" };
    }
  }
  return last;
}
