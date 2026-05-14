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

### Platform-Level Navigation

Top-level navigation contains only primary scopes:

1. **Dashboard** — Platform overview, activity, infrastructure health
2. **Clients** — Organization/team listing and management
3. **Sites** — Application/project listing across all clients
4. **Settings** — Platform-level configuration

Sponsorship links moved to footer (shown as periodic toast notification).

### Hierarchy

Mental model:
```
Dashboard (platform scope)
  ↓
Client/Organization (team scope)
  ↓
Site/Application (operational workspace)
    ├─ Overview (health, activity, resources)
    ├─ Deployments (history, logs, actions)
    ├─ Staging (sync workflows, environment status)
    └─ Settings (configuration, infrastructure)
```

### Dashboard (Platform Scope)

Platform-level operational overview:

- Total clients and sites
- Recent deployment activity across all sites
- Environments needing attention
- Failed deployments
- Backup warnings
- Infrastructure health summaries
- Quick stats (deploy frequency, success rate, avg deployment time)

### Site/Application Workspace

The Site/Application is the primary operational unit. All site-focused functionality is scoped within the site detail page using tab/section navigation.

Structure:
```
/sites/[siteId]/
  page.tsx           → Overview tab (default)
  deployments/       → Deployments tab
  staging/           → Staging tab
  settings/          → Settings tab
  layout.tsx         → Workspace layout with tab navigation
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
- Staging-specific configurations

#### Settings Tab
Site-level configuration:
- Environment variables
- Domain configuration
- Backup scheduling and retention
- Infrastructure/Coolify-specific settings
- Advanced operational settings
- Collaborator access (site-level overrides)

### Secrets and Environment Variables

Server-only secrets should live in `.env.local` during local development and in the host's environment-variable UI for deployed environments.

- `COOLIFY_API_BASE_URL` and `COOLIFY_API_TOKEN` are read only on the server.
- `NEXTAUTH_SECRET` is also server-only.
- `DATABASE_URL` is server-only.
- `NEXT_PUBLIC_*` should not be used for Coolify credentials or other secrets.
- If Coolify vars are missing, deploy actions fall back to mock/no-op behavior rather than exposing the secret requirement to the browser.

### WordPress-Specific Operational Context

For WordPress sites, add contextual operational widgets:
- Plugin update visibility
- Plugin status summaries
- WordPress core version visibility
- Maintenance-mode warnings
- Theme/plugin conflict detection

Do NOT fragment operational pages for WordPress—extend Overview/Settings with contextual info.

### Avoided Fragmentation

Do NOT create standalone pages for:
- Collaborators (shown in Overview; managed in Settings)
- Staging (tab within site workspace)
- Deployments (tab within site workspace)
- Environment details (shown in Overview; configured in Settings)

### Sponsor/Donation

Moved out of primary navigation. Instead:
- Footer link to GitHub Sponsors / OpenCollective
- Weekly toast notification encouraging support (user-dismissed, cookied)
- Lightweight, non-intrusive positioning

### Primary Workflows

1. **View operational health** → Dashboard + Site Overview
2. **Deploy application** → Site Deployments tab + deploy action
3. **Sync staging** → Site Staging tab + sync workflow
4. **Configure site** → Site Settings tab
5. **Manage team** → Site Overview (collaborators) or Settings (access control)

### UI Direction (Lightweight)

- jongo-os should avoid feeling like a generic SaaS card dashboard.
- The interface should evolve toward an operational workspace / control center.
- Cards are acceptable for summaries, but key workflows should rely on stronger spatial structure:
  - workspace headers
  - status strips
  - timelines
  - environment relationship views
  - activity feeds
  - action panels
- Site/Application pages should feel like workspaces, not disconnected report pages.
- Visual polish should follow foundation stability: authentication, database bootstrap, and Coolify integration first.

The UX direction favors inspiration from:

- Flywheel (operational focus, workflow clarity)
- Vercel (clear scope hierarchy, deployment UX)
- Render (self-hosted positioning, simplicity)
- Railway (modern operational UX, clear workflows)

But adapted for:

- self-hosted infrastructure
- Coolify-powered operations
- agency/team workflows
- operational simplicity
- workflow orientation (not entity fragmentation)

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
