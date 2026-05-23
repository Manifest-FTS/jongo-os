# jongo-os Plan

## Purpose

Create a new open-source, self-hosted Jongo distribution called `jongo-os`. This new codebase should be planned and built as an independent workspace, with Coolify-first operations and no SaaS, billing, or white-label assumptions.

## Core Direction

jongo-os is not a hosted SaaS platform.

It should be designed for:

- self-hosted deployments
- open-source distribution
- installable-by-anyone workflows
- Coolify integration
- agency and team operations
- simple deployment, upgrades, and backups

It should explicitly avoid planning around:

- Stripe billing
- tenant monetization logic
- reseller models
- white-label systems
- hosted subscription infrastructure
- provider lock-in

## Initial Scope

The first implementation step is only to establish the new `jongo-os` workspace and this planning document. Do not initialize git, scaffold an application, or move existing files until the plan is reviewed and approved.

## Current Execution Focus (Operational Pass)

This pass is focused on read-only operational correctness before any new automation.

### Priority Order

1. Operational correctness
2. Upgrade safety
3. Telemetry consistency
4. Staging-readiness UX
5. Preserve infrastructure assumptions during the upcoming Coolify 4.1 upgrade

### Hard Constraints

- Do not create or modify backup schedules from Jongo.
- Do not trigger backup creation, restore actions, or destructive backup operations from Jongo.
- Do not add hidden infrastructure assumptions into the UI or docs.
- Do not introduce execution paths that would require destructive restore behavior.
- Do not change staging behavior semantics in this pass (only simplify settings UX).
- Do not implement WordPress file/media backup logic in this pass.
- Do not mutate established backup policies automatically.

### Upgrade Safety Guardrails

- Treat Coolify 4.1 as an upgrade-risk boundary until inventory, schedule lookup, and backup telemetry continue to work unchanged.
- Preserve the current resource mapping assumptions unless a verified upstream change requires a documented adjustment.
- Keep server-side hotfixes and local docs explicit so they can be re-applied or upstreamed before a Coolify image replacement.
- Prefer additive documentation over behavior changes when clarifying backup or staging semantics.

### Backup Telemetry Acceptance Targets

- Detect existing Coolify database backup schedules.
- Detect recent successful backup execution history.
- Surface telemetry under database resource context first when app linkage is unclear.
- Link telemetry to related app/client context when enough metadata exists.
- Keep local/offsite status conceptually separate even when offsite data is not yet available.
- Validate visibility for:
  - `Jongo Database`
  - `pdb_empowermaps_prod`
  - `pdb-joyfeed-web-prod`
  - `pdb-jongo-saas-prod`

### Telemetry Consistency Rules

#### Backup UI Read-Model Contract

- What is backed up? Show the layer type first (database, files/media, source, snapshot, offsite replica).
- Is it local only or offsite replicated? Show local and offsite as separate badges or states.
- What app/client does this backup belong to? Show the stable client/app label next to the backup row.
- Can it restore app-level data, files, or whole-server state? Show restore scope explicitly.
- Is it safe to create staging from this backup? Only answer yes when the covered restore scope matches the staging workflow.

### UI Acceptance Targets
- Settings > Staging section contains concise copy only:
  - `Staging Environment`
  - `Turn on a staging copy of your production site.`
- Staging control is an explicit on/off toggle.
- Toggling staging on or off requires a confirmation panel before the action executes.
- Staging domain values can be edited in Jongo and synced back to Coolify, including comma-separated multi-domain input.
- Redundant staging status chip/copy is removed from settings.

### Current Scope Boundary

The current operational pass covers database backup telemetry only.

- Database schedules and executions are in scope.
- WordPress file/media backup execution is out of scope.
- Restore/download execution is out of scope.
- Offsite replication is documented as a required future layer, not a runtime action in this pass.
- Staging readiness should not assume files/media restore is already available.

## Planned Repository Shape

```text
jongo-os/
  docs/
    plan.md
```

## Product Goals

- Keep the Jongo branding and identity intact.
- Make deployment easy through Docker, docker-compose, curl/bash installer, and Git-based install.
- Support connection to a user’s own Coolify instance or instances.
- Focus on operational workflows: staging, deployment visibility, backups, and restore readiness.
- Favor modular architecture and portable infrastructure choices.

## MVP Information Architecture (Workflow-First)

**Terminology Update:** Sites are referred to as "Apps" in the UI/UX. This better reflects the range of infrastructure managed (websites, SaaS applications, APIs, containers, services, WordPress installs, etc.).

**Coolify Vocabulary Alignment (2026 refresh):**

- In jongo-os UI we keep the word "Clients", while Coolify API uses "Projects".
- In jongo-os UI we keep the word "Apps", while Coolify API now also exposes cross-type "Resources".
- Jongo data model should treat service/app/database as resource variants under one App workspace mental model.

This preserves user-friendly UX language while keeping backend mappings explicit and deterministic.

### Platform-Level Navigation

Top-level navigation contains only primary scopes:

1. **Dashboard** — Platform overview, activity, infrastructure health
2. **Clients** — Client/organization listing and management
3. **Apps** — Applications/projects listing across all clients
4. **Settings** — Platform-level configuration (admin only)

Sponsorship links moved to footer (shown as periodic toast notification).

### Hierarchy

Mental model:
```
Dashboard (platform scope)
  ↓
Client/Organization (team scope)
  ├─ Overview
  ├─ Apps
  ├─ Team
  └─ Settings (admin only)
  ↓
App/Application (operational workspace)
    ├─ Overview (status, environments, quick actions)
    ├─ Integrations (WordPress, provider plugins)
    ├─ Staging (sync workflows, environment status)
    ├─ Backups
    ├─ Analytics / Monitoring
    ├─ Team (collaborator management at app level)
    ├─ Settings (configuration)
    └─ Advanced (infrastructure details, diagnostics)
```

**Key Structure Change:** Team/Collaborator management has moved from Organization level to App level. This creates cleaner operational boundaries and mirrors real workflows where app-level permissions matter more than org-level roles.

### Dashboard (Platform Scope)

Platform-level operational overview:

- Total clients and apps
- Recent deployment activity across all apps
- Environments needing attention
- Failed deployments
- Backup warnings
- Infrastructure health summaries
- Quick stats (deploy frequency, success rate, avg deployment time)

### Client/Organization Workspace

The Client workspace is the team/organization scope. Horizontal tab navigation:

**Tabs:**
1. **Overview** — Team notes, profile/contact card, apps summary, recent activity
2. **Apps** — Full app directory for this client
3. **Team** — (Deprecated: team management moved to app level; kept for historical ownership records)
4. **Settings** — Client-level configuration (admin only; includes Coolify project mapping)

### App/Application Workspace

The App is the primary operational unit. All app-focused functionality uses horizontal tab navigation.

**Tabs:**
1. **Overview** — Status, environments, domains, IP addresses, quick action buttons (deploy/sync staging)
2. **Integrations** — WordPress plugin telemetry (if applicable), provider-specific integrations
3. **Staging** — Staging environment management (only if staging enabled)
4. **Backups** — Backup status, schedules, restore workflows
5. **Analytics / Monitoring** — Deployment history, performance, logs
6. **Team** — Collaborator invitations and role management for this app
7. **Settings** — App configuration (env vars, domains, publishing settings)
8. **Advanced** — Infrastructure details, Coolify UUIDs, developer diagnostics (admin only)
```

#### Overview Tab
Flywheel-style operational summary containing:
- Site health and status
- Environment summary (production, staging, dev)
- Recent deployment activity
- Collaborators and access control
- Domain configuration summary
- Backup status and last backup date
- Resource usage summaries
- Quick operational actions (deploy, sync staging, etc.)

#### Deployments Tab
Focused on deployment workflows:
- Deployment history
- Status and result for each deployment
- Deployment logs and output
- Rollback/redeploy actions
- Deployment timeline and duration
- Actor/trigger information

#### Staging Tab
Focused on staging-specific workflows:
- Staging environment status
- Production → Staging sync workflow
- Staging smoke check/validation
- Staging → Production deploy workflow
- Environment comparison/diff awareness
- Staging domain management synced to Coolify
- Staging audit history for enable, disable, and domain updates
- Staging audit history filters (all events vs domain sync events)
- Staging-specific configurations

#### Settings Tab
Site-level configuration:
- Environment variables
- Domain configuration
- Backup scheduling and retention
- Infrastructure/Coolify-specific settings
- Advanced operational settings
- Collaborator access (site-level overrides)

#### Provisioning / Creation (Future)
The App workspace should eventually support creating resources directly from Jongo instead of forcing normal setup into Coolify:

- Create Client
- Create App / Resource under a Client
- Choose resource type:
  - WordPress Site
  - Web App / Next.js / Nixpacks
  - Database
  - Service
- Provision through Coolify API
- Store Coolify UUIDs immediately
- Apply naming, domain, and dependency conventions
- Show a readiness checklist after creation

Type-specific future behavior:

- WordPress provisioning should create the WordPress app plus its DB/media dependency mapping.
- Web app provisioning should support preview/branch-style workflows.
- Database provisioning should emphasize backup and restore readiness.
- Service provisioning should emphasize health, logs, and restart readiness.

### Team Roles & Permissions

**Simplified Role Model:**

- **Owner** — Organization founder/account owner (not shown as a role; implicit)
- **Admin** — Full access to all client workspaces and their apps (platform-level administrative access)
- **Collaborator** — Standard team member with app-level permissions granted per-app (can deploy, manage staging, etc. depending on app settings)

**Permission Rules:**

- Organization admins can:
  - Invite other team members as admins or collaborators
  - Configure Coolify project mappings (admin-only settings section)
  - Access platform diagnostics and infrastructure details
  - Manage organization-level settings
- Collaborators can:
  - Deploy to their assigned apps
  - Manage staging workflows for their assigned apps
  - Invite other collaborators to their app (but cannot invite other admins)
  - View app analytics and backups
- Viewer role has been removed. Future fine-grained read-only access will be designed when required.

### Progressive Disclosure

Infrastructure details and advanced configuration are hidden by default to keep the primary UI focused on operational workflows:

- **Developer Details** (collapsed section) — Coolify UUIDs, environment IDs, service IDs
- **Advanced Tab** (app detail page) — Reserved for admin-only infrastructure diagnostics, Coolify project mapping, raw logs, debugging
- **Admin-Only Sections** — Settings tab in Client workspace shows Coolify project mapping only to admins

**Information Never Exposed:**
- Coolify API tokens (read only on server; never sent to client)
- Database passwords
- Secret environment variables (hidden unless admin explicitly views them)

### Secrets and Environment Variables

Server-only secrets should live in `.env.local` during local development and in the host's environment-variable UI for deployed environments.

- `COOLIFY_API_BASE_URL` and `COOLIFY_API_TOKEN` are read only on the server.
- `NEXTAUTH_SECRET` is also server-only.
- `DATABASE_URL` is server-only.
- `NEXT_PUBLIC_*` should not be used for Coolify credentials or other secrets.
- If Coolify vars are missing, deploy actions fall back to mock/no-op behavior rather than exposing the secret requirement to the browser.

### WordPress-Specific Operational Context

For WordPress apps, include contextual operational information:
- Plugin update visibility (via Integrations tab)
- Plugin status summaries
- WordPress core version visibility
- Maintenance-mode warnings
- Theme/plugin conflict detection

WordPress details live in the **Integrations** tab, not fragmented across the UI.

### WordPress Telemetry / REST Integration Direction

Jongo OS should support WordPress-specific operational telemetry:

- core version
- plugin list/status
- theme status
- update availability
- maintenance mode
- basic site health signals

Telemetry setup direction:

- For WordPress resources provisioned by Jongo, telemetry should be enabled automatically during provisioning.
- For existing or imported WordPress resources, Jongo should detect missing telemetry capability and present a guided setup path.
- Prefer platform-level inspection first for Coolify-managed WordPress resources.
- Use app-level Connect Telemetry (saved REST/application-password credentials) as the default product path when platform inspection is not available.
- Keep env-based REST site maps as dev/testing fallback only, not as the primary product path.
- Keep a Jongo companion plugin optional for deeper telemetry, migration workflows, or external/non-standard WordPress environments.
- Do not assume public unauthenticated WordPress REST endpoints are enough for plugin, theme, or update data.
- Do not expose sensitive WordPress admin data to collaborators unless permissions allow it.
- WordPress telemetry should live mainly under the Integrations tab.

Provider hierarchy (MVP and OSS self-hosted default):

1. Coolify/container-level inspection (WP-CLI/filesystem/env/container metadata) where available.
2. Secure WordPress REST with application passwords.
3. Optional companion plugin and/or custom upstream collector for deep telemetry.

Open-source deployment expectation:

- Jongo users who run their own Coolify stack should be able to configure telemetry without requiring a custom external collector service by default.
- The external collector path is optional and should be documented as an advanced extension, not the baseline MVP path.

### Primary Workflows

1. **View operational health** → Dashboard + Client Overview + App Overview
2. **Deploy application** → App detail page, Overview tab → Deploy button
3. **Sync staging** → App detail page, Staging tab → Sync workflow
4. **Configure app** → App Settings tab
5. **Invite team members** → App Team tab (not client level)
6. **View app history** → App Analytics/Monitoring tab (deployments, logs, performance)
7. **Create resources** → Client workspace → create App/Resource in Jongo → provision through Coolify (future)

### UI Structure Philosophy (No Card Sprawl)

- **Horizontal sections over vertical cards** — Use tab navigation to organize major sections (not ad-hoc cards)
- **Clear hierarchy** — Dashboard → Client → App (clear parent-child relationships via breadcrumbs)
- **Consistent patterns** — All workspaces use the same tab/section structure for discoverability
- **Progressive disclosure** — Advanced/admin features are hidden until needed
- **Operational focus** — Every page should answer: "What can I do here?" and "What's the current status?"

The interface should feel like a cohesive operational workspace, not a widget dashboard accumulating unrelated cards.

## Sponsor / Donation Direction

Because jongo-os is intended to be fully open-source and self-hosted, the project should include a lightweight Sponsor / Donation section rather than SaaS monetization infrastructure.

Initial planning should support:

- GitHub Sponsors links
- OpenCollective or donation links
- sponsor recognition/supporter listings
- simple project sustainability messaging

This is NOT intended to become:

- subscription billing
- SaaS account monetization
- reseller licensing
- white-label hosting

The sponsor/donation functionality should remain lightweight and optional.

## Architecture Philosophy

jongo-os should function primarily as:

- an operational UX layer
- a collaboration layer
- a workflow orchestration layer

It should NOT attempt to replace:

- Coolify
- Docker
- Kubernetes
- infrastructure providers

Coolify remains the infrastructure engine.

jongo-os focuses on:

- operational visibility
- deployment workflows
- permissions and collaboration
- simplified environment management
- user experience
- staging/deployment operations

## Initial Technical Assumptions

Initial planning should assume:

- Coolify API-driven integration
- Docker-first deployment
- self-hosted PostgreSQL or equivalent relational database
- modern React/Next.js frontend stack
- modular API/service layer
- environment-based configuration
- support for future multi-server expansion

Avoid:

- Kubernetes-first assumptions
- cloud-provider-specific dependencies
- enterprise orchestration complexity in MVP
- billing-first architecture

## MVP Prioritization Guidance

The MVP should prioritize:

1. Coolify integration
2. Operational workflows
3. Staging/deployment UX
4. Team collaboration
5. Self-hosted deployment simplicity
6. Documentation and onboarding

Avoid premature expansion into:

- enterprise orchestration
- marketplace/plugin ecosystems
- advanced infrastructure abstraction
- provider-agnostic orchestration layers
- complex SaaS platform features

## Coolify Integration Goals

The plan should eventually cover:

- deployment status visibility
- staging environment management
- backup and restore state
- infrastructure and environment configuration
- operational workflows for self-hosted teams and agencies

### App / Resource Provisioning Direction

Jongo currently supports adding Clients, but the long-term product must also support creating Apps and Resources from Jongo OS.

Future user flow:

1. Create Client
2. Create App / Resource under Client
3. Choose type:
  - WordPress Site
  - Web App / Next.js / Nixpacks
  - Database
  - Service
4. Jongo provisions the resource through the Coolify API
5. Jongo stores Coolify UUIDs immediately
6. Jongo applies naming and domain conventions
7. Jongo links databases, volumes, and dependencies where relevant
8. Jongo shows a readiness checklist after creation

Product constraints:

- Admins should not need to leave Jongo for routine resource creation.
- Coolify remains the infrastructure engine.
- Jongo remains the operational UX and orchestration layer.
- Do not implement provisioning yet unless it is already scheduled elsewhere.
- Keep this as phased future work after observation, mapping, and readiness are stable.

Type-specific future behavior:

- WordPress provisioning should eventually create both the WordPress app and its DB/media dependency mapping.
- Web app provisioning should eventually support preview/branch-style workflows.
- Database provisioning should emphasize backup and restore readiness.
- Service provisioning should emphasize health, logs, and restart readiness.

### Sequencing Guidance

The implementation order should stay conservative:

1. Observation, inventory mapping, and readiness signals
2. WordPress telemetry groundwork and guided setup for imported resources
3. App/resource provisioning flows from Jongo into Coolify
4. Execution paths for backup, restore, sync, and promote only after the above are stable

This keeps Jongo focused on operational visibility first, with provisioning and execution introduced only after the mapping and readiness model is reliable.

### Phase Gates (Readiness Before Provisioning/Execution)

Gate A: Observation and mapping baseline

- Coolify inventory is stable through resources-primary with fallbacks.
- App/resource type mapping is reliable across WordPress, Web App, Database, and Service.
- Backup readiness reasons are visible and consistent across primary app pages.
- Staging visibility rules are consistent (no staging-heavy controls when staging is not configured).

Gate B: Telemetry baseline

- WordPress telemetry contract is defined (data model, permissions, secure transport).
- Provisioned WordPress resources can auto-enable telemetry capability.
- Imported WordPress resources surface guided telemetry setup.
- Integrations tab is the primary telemetry surface with role-aware data visibility.

Gate C: Provisioning baseline

- Create-client and create-resource flows are validated in dry-run/planned mode.
- Coolify UUID persistence and dependency mapping are deterministic.
- Post-create readiness checklist is available and actionable.
- Rollback/recovery expectations for failed create operations are documented.

Execution unlock rule:

- Do not enable backup/restore/sync/promote execution paths until Gates A-C are complete and stable.

### Current Phase Definition of Done

The current phase (observation, mapping, readiness UX) is complete only when all of the following are true:

- Cross-type inventory is stable in production (WordPress, Web App, Database, Service when present).
- App workspace model copy matches resource type across Overview, Settings, Staging, and Deployments.
- Backup readiness reasons are explicit and consistent in all locked action surfaces.
- Staging visibility rules are consistent (no staging-heavy actions when staging is not configured).
- Backup architecture messaging is stateful-first and visible in planning docs.
- WordPress telemetry direction is documented with auto-enable for provisioned resources and guided setup for imported resources.
- Future provisioning direction is documented, but provisioning execution remains disabled.
- Production smoke checks are captured in docs/runbooks for each completed roadmap increment.

Only after this checklist is satisfied should implementation move to telemetry plumbing and provisioning dry-run flows.

## Backup Architecture Note (Stateful-First)

For Git-based apps, source code is already backed up in GitHub. Jongo backup readiness should focus on stateful data and operational recoverability, not code repository duplication.

Architecture decisions stabilized so far:

- [backup-domain-model.md](backup-domain-model.md) is the canonical layer model for backup scope.
- [database-backup-baseline-policy.md](database-backup-baseline-policy.md) is the database-only operational baseline.
- Jongo telemetry currently covers database backup schedules and executions, not WordPress files/media restore flows.
- WordPress full-site restore readiness requires database + files/media + offsite replication.
- Offsite replication is a durability requirement, not an optional enhancement.
- Coolify 4.1 is treated as an upgrade boundary until inventory and backup lookup behavior remain stable.

Backup domain model:

- Database backup: dump, schedule, execution history
- WordPress files/media backup: `wp-content/uploads` and site-specific files
- Code/source backup: Git provider is the source of truth for Git-based apps
- Server snapshot / disaster recovery: whole-server controls such as Hetzner snapshots or restic
- Offsite replication: local backups are not sufficient until copied to Backblaze B2 or compatible S3 storage

Jongo backup readiness scope for app-level operations:

- databases
- uploaded files and media
- persistent volumes
- environment and configuration metadata

Infrastructure snapshot policy:

- Hetzner/server snapshots are disaster-recovery controls only.
- Snapshots are not the primary app-level restore UX in Jongo.

Offsite policy:

- production database backups should ultimately replicate offsite
- future WordPress file/media backups should also replicate offsite
- Jongo should eventually surface both local backup state and offsite replication state

WordPress completeness rule:

- Backup readiness is incomplete unless both data planes are covered:
  - WordPress database
  - `wp-content/uploads` and media assets

Restore scope matrix:

- Database backup can restore content, settings, users, and plugin data stored in the DB.
- WordPress files/media backup can restore uploads and site-specific `wp-content` files.
- Code/source backup is already externalized through Git and is not duplicated by Jongo.
- Server snapshots support infrastructure recovery, not app-level restore UX.
- Offsite replication is a durability requirement, not a separate restore layer.

Staging safety rule:

- A backup is not staging-safe for full WordPress clone workflows unless both database and files/media coverage exist and offsite replication is known.
- Jongo should eventually surface that distinction instead of treating all backups as equivalent.

Upgrade safety rule:

- Backup and staging assumptions should remain valid across Coolify upgrades unless the change is explicitly documented and verified.
- If upstream changes resource shapes or backup lookup behavior, capture that in docs before changing runtime logic.

Execution boundary for this phase:

- Document and surface readiness signals only.
- Do not implement backup execution, restore execution, or destructive backup actions yet.

### API Alignment Track (Current Priority)

Near-term roadmap work should keep the implementation aligned to current Coolify API docs:

1. Keep project mapping on `GET /api/v1/projects` with write support on `PATCH/DELETE /api/v1/projects/{uuid}` when mutating workflows are enabled.
2. Introduce `GET /api/v1/resources` as the canonical cross-type inventory feed for Apps directory aggregation.
3. Keep `GET /api/v1/services` and `POST /api/v1/services` for service-specific create/read operations.
4. Keep environment lifecycle attached to projects via `POST /api/v1/projects/{uuid}/environments`.
5. Preserve API bootstrap check with `GET /api/v1/enable` and document root-permission requirement in deployment runbooks.

### API Alignment Execution Status (2026-05-16)

Completed in codebase:

1. Added runtime diagnostics instrumentation for:
  - endpoint-level Coolify call status, success/failure, response counts
  - inventory source attribution (`db`, `coolify`, `hybrid`, `mock`)
  - auth/session scope-filter diagnostics
  - env-presence checks without secret exposure
  - last successful and last non-empty inventory timestamps
2. Added protected diagnostics surfaces:
  - admin/dev diagnostics section under Settings -> Developer Details
  - protected endpoint: `GET /api/diagnostics/runtime` (supports `?probe=1`)
3. Kept existing fallback behavior intact (no fallback removals).
4. Switched Coolify inventory aggregation to resources-primary:
  - attempts `GET /api/v1/resources` first
  - falls back to legacy `applications/services/databases` calls when needed

Current production finding (must resolve next):

- Production Coolify API requests are failing authentication (`Unauthenticated` / non-reachable in connection checks).
- Production database currently has no Site rows, so when Coolify inventory fails auth, Apps can resolve to zero.

Immediate next actions:

1. Deploy current diagnostics/resources-primary build to production.
2. Rotate/validate production Coolify API token and API enablement state.
3. Re-run diagnostics probe in production and verify endpoint success for inventory calls.
4. Confirm Apps inventory is non-empty from live Coolify feed when DB Sites are zero.
5. Capture final verification in runbook docs before additional feature work.

## Next Implementation Phases

**Phase 1: Core Product + Coolify Validation (MVP)**

1. Confirm the plan and lock the scope.
2. Create the `jongo-os` repository workspace structure.
3. Build application, database, auth, and core Coolify integration.
4. Deploy continuously on your Coolify cluster.
5. Validate operational workflows: staging, deployments, backups, team collaboration.
6. Document assumptions and configuration surface (.env, compose, config files).

Success criteria: Full product usable on your infrastructure. Operational stability. Reproducible architecture via Git + Docker.

**Phase 2: Self-Hosted Installation Paths (Post-MVP)**

1. Finalize and document Git + docker-compose installation path.
2. Add .env.example with all required parameters.
3. Write onboarding docs for first technical adopters.
4. Validate installation on external infrastructure (VPS, homelab, etc.).
5. Build curl-based installer and one-command quickstart.
6. Publish v1.0 as stable self-hosted release.

Success criteria: First 50 external users can self-host successfully. Installer is maintainable. Documentation is complete.

## Delivery Order and Mental Model

**Mental Model:**

"Jongo is a self-hosted platform that happens to first run on Kevin's Coolify cluster."

NOT:

"Jongo is Kevin's internal tool that later becomes installable."

**Phase 1 — Core Product + Coolify Validation** (MVP)

Build the complete product once, parameterized for any infrastructure:

- Application and data models
- Authentication and authorization
- Database schema and migrations
- Worker services and background jobs
- Storage and backup integration
- Deployment and upgrade assumptions

Deploy through:

- Git + Docker (clone repo, configure .env, docker compose up)
- Your Coolify instance as primary deployment target

This delivers:

- Real operational experience
- Logging and observability lessons
- Scaling and performance data
- Security considerations in practice
- Backup and restore validation
- Upgrade workflows

Without prematurely building installer tooling.

**Phase 2 — Official Self-Hosted Paths** (Post-MVP)

After architecture and services stabilize:

**Step 1: Git + Documentation (Early Adopter Path)**

Example:
```bash
git clone https://github.com/manifest-fts/jongo-os.git
cd jongo-os
cp .env.example .env
# edit .env with your values
docker compose up -d
```

**Step 2: One-Command Installer (Mass Adoption Path)**

Example:
```bash
curl -fsSL https://install.jongo.dev | bash
```

Ship Step 2 only after:

- .env structure is stable
- Services are stable
- Migrations are stable
- Storage paths are stable
- Backup/restore workflows are proven

Otherwise you'll constantly rewrite installer logic.

**Critical Architectural Rule**

Avoid anything that depends specifically on:

- your domains or DNS
- your Coolify naming conventions
- your server layout
- your secrets structure
- your local storage paths

Everything must be parameterized via:

- `.env` and `.env.example`
- `docker-compose.yml` variables
- Configuration files
- CLI flags

This ensures your deployment, another person's VPS, a homelab, Hetzner, DigitalOcean, bare metal, Proxmox, and Coolify all behave identically.

**Market Positioning**

The clean positioning is:

> Open-source operational collaboration platform. Self-hostable. Coolify-friendly. Docker-first.

This resonates with:

- DevOps teams
- Agencies
- Nonprofits
- Small organizations
- Privacy/sovereignty-minded users
- Teams leaving SaaS lock-in

Your own infrastructure becomes R&D, not "special internal tooling."

## Out of Scope For Now

- SaaS billing systems
- tenant billing or monetization
- white-label/reseller features
- enterprise multi-tenant platform design
- hosted customer-account infrastructure

## Important Direction Reminder

jongo-os is:

- open-source
- self-hosted
- Coolify-first
- operationally focused
- agency/team oriented

It is NOT:

- a hosted SaaS platform
- a reseller platform
- a white-label hosting panel
- a billing/subscription platform
- a replacement for infrastructure orchestration systems

## Potential Future Extensions

Possible future capabilities may include:

- plugin/extensions system
- additional infrastructure adapters beyond Coolify
- Git provider integrations
- monitoring integrations
- CLI tooling
- automation hooks/webhooks

These are not part of the MVP scope.
