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
- `npm run dev:web`
- `npm run start`
- `npm run type-check`
- `npm run build`
- `npm run db:migrate`
- `npm run db:migrate:deploy`
- `npm run db:migrate:status`
- `npm run bootstrap:local`
- `npm run smoke:coolify`
- `npm run dev:web:env`
- `npm run start:web:env`
- `npm run docker:up`
- `npm run docker:down`

## Production Runtime Notes

- This project uses the regular Next.js server runtime.
- Canonical production entrypoint is `npm run start`.
- `npm run start` runs Prisma client generation, then `prisma migrate deploy`, then starts the web server.
- Startup aborts with a non-zero exit code if migrations fail, so broken schema changes do not serve traffic.
- Docker and Nixpacks/Coolify both use the same `npm run start` entrypoint.

Prisma client generation is required for production bootstrap/auth/database routes.

- Prisma generation is wired into:
	- `postinstall` (runs on install)
	- `build` (runs before Next build)
	- `start` (runs before migration and app start)

For Coolify/Nixpacks deployments, this repository includes `nixpacks.toml` to enforce:

- `npm ci`
- `npm run prisma:generate`
- `npm run build`
- start with `npm run start`
- Node.js 20 runtime parity with the Docker image

Startup behavior:

- Runtime applies committed Prisma migrations on boot before the app starts.
- If migrations fail, startup stops and logs the failure with `[startup]` messages.
- Normal upgrades should not require SSH access or manual SQL.
- Advanced recovery steps are documented in [docs/self-hosted-database-migrations.md](docs/self-hosted-database-migrations.md).

## Migration Workflow

- Development schema changes should use `npm run db:migrate -- --name <migration_name>` and commit the generated `prisma/migrations/*` directory.
- Production and self-hosted deployments should use `npm run start`, which includes `npm run db:migrate:deploy` automatically.
- `prisma db push` is not part of the normal Jongo OS development or production workflow.
- See [docs/self-hosted-database-migrations.md](docs/self-hosted-database-migrations.md) for self-hosted upgrades, deployment expectations, and failure recovery.

## Environment

- `COOLIFY_API_BASE_URL`
- `COOLIFY_API_TOKEN`
- `COOLIFY_TIMEOUT_MS` (optional; defaults to 8000)

## Local Install Path

1. `cp .env.example .env` (or copy manually on Windows)
2. Fill in `.env` values for DB, auth, and Coolify API
3. Start the SSH tunnel workflow in [docs/local-development.md](docs/local-development.md) and set `DATABASE_URL` to `localhost:5433`
4. Run `npm run bootstrap:local`
5. Run `npm run dev:web`

If you use `npm run dev:web:env` or `npm run start:web:env`, the repo-root `.env.local` is loaded by the wrapper script. For plain `npm run dev` or `npm run dev:web`, the web app reads `apps/web/.env.local`.

If your Coolify credentials are in root `.env`, use `npm run dev:web:env` so the web process receives them.

## Docker Compose Path

1. Ensure Docker is installed
2. Prepare `.env` from `.env.example`
3. Run `npm run docker:up`
4. Open `http://localhost:3000`

The web container runs `npm run start`, so committed Prisma migrations are applied automatically before the app accepts traffic.

## Real Coolify Validation

Use these routes after your env vars are configured:

- `/api/coolify/connection` - returns connectivity status and explicit error details
- `/api/coolify/status` - returns live/mock mode plus current site stats
- `/api/health` - service health route

You can run a local smoke test (with app running) using:

- `npm run smoke:coolify`

To fail fast unless live data is active:

- PowerShell: `$env:EXPECT_LIVE='true'; $env:APP_BASE_URL='http://localhost:3000'; npm run smoke:coolify`

## App Surface (MVP)

- dashboard
- organizations
- sites
- site detail
- staging
- deployments
- collaborators
- sponsor
