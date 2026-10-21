# Platform shell UX — implemented UI, 2026-10-20

This records the current authenticated shell and reported local evidence, not a new implementation plan or production sign-off.

## Shell and navigation

- The [platform layout](../apps/web/src/app/%28platform%29/layout.tsx) and scoped [platform stylesheet](../apps/web/src/styles/brand-platform.css) use a light canvas, dark sidebar/header, blue actions, pastel dashboard statistics, 12px panels and 8px controls. Public/auth styling is outside this shell scope.
- [Primary navigation](../apps/web/src/components/navigation/PlatformPrimaryNav.tsx) retains real route links: Dashboard, Clients, Apps, Domains, Usage and Settings. Domains and Settings have separate disclosure buttons; the current branch opens on navigation, remains manually collapsible, and Escape collapses/refocuses it. Client billing and Users & access remain gated by the existing fresh super-admin check. Financial authorization, billing behavior and pricing are unchanged.

## Workspace query and route scope

- [WorkspaceSwitcher](../apps/web/src/components/navigation/WorkspaceSwitcher.tsx) uses server-provided initial options and authenticated `GET /api/workspaces` on opening/search/pagination. It provides loading, empty, retry and load-more states, aborts superseded requests, and never substitutes demo workspaces.
- The [query service and DTO](../apps/web/src/lib/workspace-switcher.ts) re-read the non-deleted user and live organization ownership/collaborator scope. Session roles, technical/platform grants and site-only grants do not expand the list. The [API](../apps/web/src/app/api/workspaces/route.ts) is private/no-store and returns 401 for unauthenticated access, 400 for invalid queries and 503 for unavailable service.
- `WorkspaceOption` contains only `id`, `name`, `slug`, `planLabel`; `WorkspacePage` adds `items`, `hasMore`, `nextCursor`. Search is bounded to 100 characters; page size is 1–100, ordered by name/id with a search-bound cursor. No financial/provider DTO is sent to the switcher.
- A plan badge comes only from the actual owner's fresh, active, unexpired recognized subscription; missing/invalid/deleted-owner states produce `null`, not a fabricated Starter plan. Studio/Scale are display labels for the existing stored IDs, not new billing plans or entitlement grants.
- Active organization is derived only from a matching `/clients/{id-or-slug}` route among known options. Selecting a workspace navigates to `/clients/{id}`; All workspaces links to `/clients`. This is **route context only**, not a global organization selector/filter, persisted context or authorization boundary for other pages/APIs.

## Reused creation drawer

- Both the Clients action and switcher reuse [CreateOrganizationForm](../apps/web/src/components/CreateOrganizationForm.tsx), backed by the native modal [ModalDrawer](../apps/web/src/components/overlays/ModalDrawer.tsx). It provides Name/optional Description, initial focus, Cancel/close/backdrop dismissal, explicit Escape handling, reversible scroll locking and focus restoration. The switcher stays mounted while its nested modal is open.
- Submission reuses the existing `POST /api/organizations` [handler](../apps/web/src/app/api/organizations/route.ts) and flat response DTO; it does not introduce a backend creation API. Client validation, duplicate-submit protection, errors and request cancellation are implemented. Successful switcher creation is wired to navigate to the returned organization ID. **No organization creation or other post-auth mutation was executed during browser acceptance.**

## Footer and notification prompt

- [PlatformBrandFooter](../apps/web/src/components/brand/PlatformBrandFooter.tsx) and its [stylesheet](../apps/web/src/components/brand/PlatformBrandFooter.module.css) retain the original Manifest M geometry, Josefin Sans 600 wordmark, DM Sans tagline and real Manifest/Jongo/settings links. Only the seal text ring loops, once per 30 seconds; the center mark is static. A pause control toggles the loop, and reduced motion disables it.
- The initial browser pass found that the fixed desktop-notification prompt could cover the switcher creation action/footer at narrow widths. The [prompt](../apps/web/src/components/DesktopNotificationPrompt.tsx) now has a class targeted by a shell-only [normal-flow override](../apps/web/src/styles/brand-platform.css#L336-L343): static positioning, full grid span, bounded width and automatic stacking. **The fix's rendered/computed placement was not verified in the browser because notification permission was denied and the prompt did not render.** Source inspection is not computed-style/browser proof.

## Verification chronology and limits

1. The first authenticated visible-browser pass against real localhost UI/API reported **73 passing checks** across **360, 768 and 1440px**, including no horizontal overflow, live workspace loading/search/selection, navigation disclosures, drawer dismissal/focus/scroll restoration, footer layout/fonts, 30-second ring, pause and reduced motion. The prompt obstruction above was identified in that pass; these results do not certify its later fix.
2. Later, after explicit drawer Escape handling was added, trusted keyboard checks in the shared browser and visible Edge confirmed Escape from Name was prevented, the dialog closed without native cancel, and focus/expanded state restored. For the nested switcher, the first Escape closed only the drawer; the second closed/refocused the switcher. These are separate follow-up checks, **not a revised 73-check total**. The focused drawer/form/switcher run reported 60 passing tests and web type-check passed; this is not a full-suite count.
3. The reported `npm run verify:local` run passed **before the extra Escape regression tests**. The parent agent will rerun full verification; no final new suite/test total or post-Escape full-verification result is claimed here. No suites or browser checks were executed by this documentation-only pass.

No backend changes, configured/production migrations, deployment, new-site scaffold or Phase 2 completion are implied. This shell pass does not complete the CMS/import/media roadmap or authorize further work.