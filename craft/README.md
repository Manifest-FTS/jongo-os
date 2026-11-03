# @jongo/craft — preview 0.1

Independent ESM React 19 package: generic typed Craft shell, shared UI and a fictional Golf Lab extension. **Not a production backend.** No Jongo admin/auth/billing dependencies.

Exports: `@jongo/craft`, `@jongo/craft/golf-lab`, `@jongo/craft/logic`, `@jongo/craft/styles.css`. Import CSS explicitly. `npm ci --ignore-scripts`, `npm test`, `npm pack` build JavaScript, declarations and scoped CSS using the locked toolchain. Peer dependencies: React and React DOM 19.

Preview.6 retains role-scoped RFC 5545 Golf calendar downloads and restores labeled native date inputs using the existing scoped form styles. Schedule day, booking/edit, inclusive recurrence end, reports, admin resume review and style-guide dates use browser-native controls; the custom picker, its export, standalone CSS and theme tokens have been removed. Booking day/week grids and normal week/Today buttons are preserved. Downloads are snapshots, not calendar sync, OAuth integration or provider invitations; neutral CMS is unchanged.

Full boundary, review scenarios, limitations and vendor-artifact deployment instructions: `jongo/docs/craft-preview.md` in the source repository. Browser demo changes are fictional and in-memory. Never use the role switch as real authorization.