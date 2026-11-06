import type { CraftAction } from '../server/auth.js';

export const CRAFT_ROLES = ['reader', 'editor', 'publisher', 'admin'] as const;
export type CraftRole = (typeof CRAFT_ROLES)[number];
export const isCraftRole = (value: unknown): value is CraftRole => typeof value === 'string' && (CRAFT_ROLES as readonly string[]).includes(value);

const READER: readonly CraftAction[] = ['read'];
const EDITOR: readonly CraftAction[] = ['read', 'read-drafts', 'write'];
const PUBLISHER: readonly CraftAction[] = [...EDITOR, 'publish'];
const ADMIN: readonly CraftAction[] = [...PUBLISHER, 'export'];

/**
 * Craft actions a Jongo role allows. `import`, `export-private` and `admin` are never granted here: a site must opt in separately.
 * `via` (for example a Jongo platform admin) is accepted for the caller's audit trail and deliberately does not widen anything.
 */
export function mapRoleToActions(role: unknown, _options: { via?: string } = {}): CraftAction[] {
  switch (role) {
    case 'reader': return [...READER];
    case 'editor': return [...EDITOR];
    case 'publisher': return [...PUBLISHER];
    case 'admin': return [...ADMIN];
    default: return [];
  }
}
