# Coolify API Exploration (Pass 1)

## Objective

Define first integration milestones for Coolify-driven operations in jongo-os.

## MVP Integration Targets

- list resources (services, apps, databases) and environments
- read deployment history and latest statuses
- trigger production to staging sync workflow
- trigger staging to production deploy workflow
- surface backup and restore status signals when available

## Initial Technical Shape

- route handlers in web app for server-side API calls
- service module for Coolify API client and normalization
- environment-driven configuration for API URL and auth token

## Proposed Environment Variables

- `COOLIFY_API_BASE_URL`
- `COOLIFY_API_TOKEN`
- `COOLIFY_TIMEOUT_MS`

## Discovery Checklist

- confirm endpoint coverage for app listing, deployment history, and deploy triggers
- capture pagination and rate-limit behavior
- identify webhook/event options for near-real-time deployment visibility
- document fallback polling strategy for MVP

## Coolify API v1 Refresh (2025-10 docs)

Terminology alignment used by jongo-os:

- jongo-os Client = Coolify Project
- jongo-os App = Coolify Resource (service/app/database)
- jongo-os Environment = Coolify Project Environment

Key reference endpoints from current Coolify docs:

- API enablement: `GET /api/v1/enable` (root permissions required)
- List projects: `GET /api/v1/projects`
- Update project: `PATCH /api/v1/projects/{uuid}`
- Delete project: `DELETE /api/v1/projects/{uuid}`
- Create environment under project: `POST /api/v1/projects/{uuid}/environments`
- List resources (cross-type): `GET /api/v1/resources`
- List services: `GET /api/v1/services`
- Create service: `POST /api/v1/services`

Implementation direction:

- Keep `/api/v1/services` support for service-specific details and operations.
- Add `/api/v1/resources` as the canonical cross-resource listing source where possible.
- Preserve defensive normalization because Coolify payload shape can vary by resource type.

## Notes

Hosting docs under `hosting/docs` should be treated as operational references for deployment patterns, not as final API contracts.

## Implemented (Pass 2)

- Added server-only API client in `apps/web/src/lib/coolify.ts`
- Added bearer-token read calls to:
	- `/api/v1/projects`
	- `/api/v1/applications`
	- `/api/v1/services`
	- `/api/v1/databases`
	- `/api/v1/deployments`
- Added normalization layer to map payload shape differences into stable internal types:
	- `SiteOverview`
	- `DeploymentRecord`
	- `CoolifyOverview`
- Added fallback mock mode when env vars are missing or API calls fail
- Added internal read endpoint `GET /api/coolify/overview`

## Current Contract

- The app does not trigger mutating Coolify actions yet.
- All current Coolify usage is read-only.
- If live calls fail, UX remains functional through mock overview data.
