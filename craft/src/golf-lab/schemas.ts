import type { ContentSchema } from '../shell.js';
/** Content-only subset following Jongo CMS TypeDefinition names; not a full studio contract.
 * Registry, native envelopes, draft/publication validation and persistence stay upstream.
 * These documents hold copy ONLY, never reservations, billing, waivers or memberships. */
export const golfLabContentSchemas = [
  { name: 'golfLabNotice', type: 'document', title: 'Golf Lab member notice', schemaVersion: 1, fields: [
    { name: 'title', type: 'string', required: true, maxLength: 120 },
    { name: 'body', type: 'text', required: true, maxLength: 2000 }
  ] },
  { name: 'golfLabHelp', type: 'document', title: 'Golf Lab help copy', schemaVersion: 1, fields: [
    { name: 'question', type: 'string', required: true, maxLength: 200 },
    { name: 'answer', type: 'text', required: true, maxLength: 3000 }
  ] }
] as const satisfies readonly ContentSchema[];