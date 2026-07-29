import { describe, expect, it } from "vitest";
import { normalizeBackupNote, BACKUP_NOTE_MAX_LENGTH } from "./backup-note";

describe("normalizeBackupNote", () => {
  it("keeps an ordinary note as written", () => {
    expect(normalizeBackupNote("before plugin upgrade").value).toBe("before plugin upgrade");
  });

  it("treats empty and whitespace as clearing the note, not as no-change", () => {
    expect(normalizeBackupNote("").value).toBeNull();
    expect(normalizeBackupNote("   ").value).toBeNull();
    expect(normalizeBackupNote("\n\t").value).toBeNull();
  });

  it("treats null and undefined as no note", () => {
    expect(normalizeBackupNote(null).value).toBeNull();
    expect(normalizeBackupNote(undefined).value).toBeNull();
  });

  it("collapses newlines so a pasted note cannot break the row layout", () => {
    expect(normalizeBackupNote("before\nthe\tupgrade").value).toBe("before the upgrade");
    expect(normalizeBackupNote("  spaced   out  ").value).toBe("spaced out");
  });

  it("reports when a note was too long rather than silently truncating in silence", () => {
    const long = "x".repeat(BACKUP_NOTE_MAX_LENGTH + 25);
    const r = normalizeBackupNote(long);
    expect(r.tooLong).toBe(true);
    expect(r.value).toHaveLength(BACKUP_NOTE_MAX_LENGTH);
  });

  it("does not flag a note exactly at the limit", () => {
    const exact = "x".repeat(BACKUP_NOTE_MAX_LENGTH);
    const r = normalizeBackupNote(exact);
    expect(r.tooLong).toBe(false);
    expect(r.value).toBe(exact);
  });

  it("coerces non-strings instead of throwing", () => {
    expect(normalizeBackupNote(42).value).toBe("42");
    expect(normalizeBackupNote(false).value).toBe("false");
  });

  it("measures length after collapsing, so whitespace cannot trip the limit", () => {
    const padded = `  ${"x".repeat(BACKUP_NOTE_MAX_LENGTH)}   `;
    expect(normalizeBackupNote(padded).tooLong).toBe(false);
  });
});
