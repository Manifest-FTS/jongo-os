# Coolify API Exploration (Pass 1)

## Objective

Define first integration milestones for Coolify-driven operations in jongo-os.

## MVP Integration Targets

- list applications and environments
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

## Notes

Hosting docs under `hosting/docs` should be treated as operational references for deployment patterns, not as final API contracts.

## Implemented (Pass 2)

- Added server-only API client in `apps/web/src/lib/coolify.ts`
- Added bearer-token read calls to:
	- `/api/v1/services`
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
