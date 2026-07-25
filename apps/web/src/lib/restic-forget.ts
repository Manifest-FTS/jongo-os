/**
 * Parse `restic forget --json` output into the list of snapshots it REMOVED.
 *
 * This exists because the obvious approach — scraping restic's human-readable
 * output for lines starting with a short id — is wrong in a way that is both
 * silent and destructive. restic prints the snapshots it is KEEPING in exactly
 * the same table shape as the ones it removes:
 *
 *     keep 1 snapshots:
 *     ID        Time                 Host      Tags ...
 *     2ae64053  2026-07-25 09:48:44  my-site   ...
 *
 * so the scrape returned the freshly created snapshot as "forgotten". Every new
 * backup was then marked pruned the instant it was taken, which silently turns
 * off restore for the whole platform. Verified against restic 0.16.4, where a
 * run with nothing to remove reports `"remove": null` (not `[]`).
 *
 * The contract here is deliberately asymmetric: when the input cannot be
 * understood, return NOTHING. A wrong id in this list marks a good backup
 * unrestorable; a missing one only leaves a catalogue row stale until the next
 * run corrects it.
 */

export function parseForgottenSnapshotIds(json: unknown): string[] {
  let groups: unknown = json;

  if (typeof json === "string") {
    const trimmed = json.trim();
    if (!trimmed) return [];
    try {
      groups = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(groups)) return [];

  const ids: string[] = [];
  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    // `remove` is null rather than [] when the policy removes nothing.
    const removed = (group as { remove?: unknown }).remove;
    if (!Array.isArray(removed)) continue;
    for (const snapshot of removed) {
      if (!snapshot || typeof snapshot !== "object") continue;
      const raw = (snapshot as { short_id?: unknown; id?: unknown });
      const id = typeof raw.short_id === "string" && raw.short_id.trim()
        ? raw.short_id.trim()
        : typeof raw.id === "string" && raw.id.trim()
          ? raw.id.trim().slice(0, 8)
          : "";
      if (id) ids.push(id);
    }
  }
  return Array.from(new Set(ids));
}

/** Decode the base64 line the backup script emits, then parse it. */
export function parseForgottenSnapshotIdsFromBase64(encoded: string | null | undefined): string[] {
  const value = String(encoded ?? "").trim();
  if (!value) return [];
  try {
    return parseForgottenSnapshotIds(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return [];
  }
}
