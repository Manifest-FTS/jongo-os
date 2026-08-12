/**
 * Choosing a site slug that the database will actually accept.
 *
 * Site has `@@unique([organizationId, slug])`, and that constraint does NOT
 * exclude soft-deleted rows. Archiving is a soft delete, so every archived app
 * keeps its slug reserved forever — in one real organisation, ten of twelve rows
 * were archived and their names were all unusable. Creating an app with any of
 * those names failed with P2002, and because the Coolify service is provisioned
 * BEFORE the row is written, each attempt left a real orphaned service behind.
 *
 * A suffix is used rather than a partial unique index because slugs are also
 * looked up by name in several places: freeing the slug for reuse would mean two
 * rows sharing one, and any lookup that forgot to filter `deletedAt` would
 * silently resolve to the archived one.
 */

export function toSiteSlug(name: string): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/** Reserve headroom for the "-NN" suffix inside the 60-character budget. */
const MAX_SLUG_LENGTH = 60;

/**
 * The first free slug in the `base`, `base-2`, `base-3`, … sequence.
 *
 * `taken` must include soft-deleted slugs, because the unique constraint does.
 * Comparison is case-insensitive since slugs are always lowercased.
 */
export function nextAvailableSlug(base: string, taken: Iterable<string>): string {
  const normalizedBase = toSiteSlug(base) || "app";
  const used = new Set(Array.from(taken, (value) => String(value ?? "").trim().toLowerCase()).filter(Boolean));

  if (!used.has(normalizedBase)) {
    return normalizedBase;
  }

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const tail = `-${suffix}`;
    // Truncate the stem, not the suffix: a trimmed suffix would collide again.
    const stem = normalizedBase.slice(0, MAX_SLUG_LENGTH - tail.length).replace(/-+$/g, "");
    const candidate = `${stem}${tail}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }

  // A thousand collisions is not a naming problem, so fall back to something
  // that cannot collide rather than looping further.
  const unique = Math.random().toString(36).slice(2, 8);
  const stem = normalizedBase.slice(0, MAX_SLUG_LENGTH - unique.length - 1).replace(/-+$/g, "");
  return `${stem}-${unique}`;
}
