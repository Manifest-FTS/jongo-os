/**
 * The one rule for a backup note.
 *
 * Shared by creating a backup and editing one afterwards, because two places
 * applying slightly different rules is how "before plugin upgrade" becomes
 * "before plugin upgrad" in one path and a 400 in the other.
 *
 * Clearing is a real operation: an empty string means "remove the note", not
 * "no change". The caller distinguishes those by whether `label` was sent at
 * all, so an omitted field never wipes a note by accident.
 */

export const BACKUP_NOTE_MAX_LENGTH = 200;

export type NormalizedBackupNote = {
  /** Null when the note is being cleared. */
  value: string | null;
  tooLong: boolean;
  maxLength: number;
};

export function normalizeBackupNote(input: unknown): NormalizedBackupNote {
  if (input === null || input === undefined) {
    return { value: null, tooLong: false, maxLength: BACKUP_NOTE_MAX_LENGTH };
  }

  // Collapse whitespace so a note pasted from a terminal or an editor does not
  // arrive with newlines that break the single-line row layout.
  const collapsed = String(input).replace(/\s+/g, " ").trim();

  if (collapsed.length === 0) {
    return { value: null, tooLong: false, maxLength: BACKUP_NOTE_MAX_LENGTH };
  }

  return {
    value: collapsed.slice(0, BACKUP_NOTE_MAX_LENGTH),
    tooLong: collapsed.length > BACKUP_NOTE_MAX_LENGTH,
    maxLength: BACKUP_NOTE_MAX_LENGTH
  };
}
