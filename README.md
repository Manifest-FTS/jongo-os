# jongo-os

Open-source, self-hosted Jongo distribution focused on operational UX for teams using Coolify-managed infrastructure.

## Current State

This repository now includes pass-2 implementation for branded UI and read-only Coolify integration:

- monorepo workspace initialized
- Next.js web app with branded shell and atmospheric styling
- read-only Coolify API service with mock fallback
- overview API endpoint at `/api/coolify/overview`
- data-backed MVP pages (dashboard, sites, site detail, staging, deployments)
- architecture and integration planning docs

## Principles

- self-hosted first
- open-source first
- Coolify-first integration strategy
- no SaaS billing or subscription assumptions

## Commands

- `npm install`
- `npm run dev`
- `npm run type-check`
- `npm run build`

## Environment

- `COOLIFY_API_BASE_URL`
- `COOLIFY_API_TOKEN`
- `COOLIFY_TIMEOUT_MS` (optional; defaults to 8000)

## App Surface (MVP)

- dashboard
- organizations
- sites
- site detail
- staging
- deployments
- collaborators
- sponsor
