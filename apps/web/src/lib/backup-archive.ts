/**
 * Naming and addressing a downloaded backup archive.
 *
 * Split out from the route because both halves are easy to get quietly wrong and
 * neither needs a network to test: the snapshot id goes into a shell command on
 * the backup host, and the filename goes into a Content-Disposition header.
 */

/**
 * restic snapshot ids are hex — either the 8-character short form the catalogue
 * stores or the full 64-character id.
 *
 * This is a SECURITY boundary, not tidiness. The id is interpolated into a bash
 * script that runs as root on the backup host, and while it currently arrives
 * from our own database, a validator that only trusts hex means a future caller
 * that passes a snapshot id straight from a request cannot turn it into a
 * command. Shell-quoting alone would rely on every future edit remembering to
 * quote.
 */
export function isValidSnapshotId(value: string | null | undefined): boolean {
  return /^[0-9a-f]{8,64}$/i.test(String(value ?? "").trim());
}

/** Single-quote a value for bash, escaping any embedded quote. */
export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * A filename that says which site and which point in time, so a folder of
 * downloads from several sites stays legible. Deliberately not the restic
 * snapshot id: that identifies the backup to us, not to the person who now has
 * a tar file in their downloads folder.
 */
export function buildArchiveFilename(input: {
  siteSlug?: string | null;
  siteName?: string | null;
  startedAt: Date | string;
}): string {
  const rawLabel = String(input.siteSlug || input.siteName || "backup");
  const label =
    rawLabel
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "backup";

  const started = input.startedAt instanceof Date ? input.startedAt : new Date(input.startedAt);
  // UTC, and minute precision: the catalogue shows UTC, so a filename in local
  // time would disagree with the row it came from. Invalid dates fall back to
  // an unstamped name rather than "nan" appearing in the filename.
  const stamp = Number.isNaN(started.getTime())
    ? ""
    : `-${started.toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;

  return `${label}${stamp}.tar`;
}

/**
 * Build the host script that streams a snapshot as a tar on stdout.
 *
 * `restic dump --archive tar <snap> /` walks the snapshot and writes the archive
 * straight out, so nothing is staged on the host's disk — which matters because
 * the backup host has 105 GB free and some of these sites are large.
 *
 * Everything diagnostic goes to stderr: stdout is the archive, and a single
 * stray echo would corrupt it.
 */
export function buildArchiveScript(snapshotId: string): string {
  if (!isValidSnapshotId(snapshotId)) {
    throw new Error("Refusing to build an archive command for a non-hex snapshot id.");
  }

  return `set -uo pipefail
if [ ! -f /root/.config/restic/b2-credentials.env ]; then
  echo "fail_no_b2_creds" >&2
  exit 3
fi
set -a; . /root/.config/restic/b2-credentials.env; set +a
export AWS_ACCESS_KEY_ID="\${B2_KEY_ID:-}" AWS_SECRET_ACCESS_KEY="\${B2_APPLICATION_KEY:-}"
REPO="s3:\${B2_ENDPOINT}/\${B2_BUCKET}"
exec /usr/bin/restic -r "$REPO" dump --archive tar ${shellQuote(snapshotId)} /
`;
}
