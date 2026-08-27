/**
 * Whether a Site/Organization description leaks internal infrastructure
 * detail that a collaborator must never see (see repo policy: no Coolify
 * references in the operational layer collaborators can view).
 *
 * A one-off sync script once wrote "Imported from approved Coolify ownership
 * mapping" into Site.description, a free-text field collaborators can see on
 * every page of their app. That specific string is now fixed at the source
 * (scripts/sync-approved-coolify-mappings.mjs) and cleaned up in existing
 * rows via migration, but description is still admin-editable free text, so
 * this is checked at render time too: an admin typing "Coolify" into a
 * description by habit must not leak it to collaborators either.
 */
export function isInternalOnlyDescription(description: string | null | undefined): boolean {
  return Boolean(description && /coolify/i.test(description));
}

/** null hides the description entirely for a non-admin viewer rather than showing a redacted string. */
export function describeForViewer(
  description: string | null | undefined,
  isAdminViewer: boolean
): string | null {
  if (!description) return null;
  if (!isAdminViewer && isInternalOnlyDescription(description)) return null;
  return description;
}
