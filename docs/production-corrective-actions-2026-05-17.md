# Production Corrective Actions - 2026-05-17

Scope: corrective actions only (no feature additions) for migration state, platform admin detection, site mapping sync readiness, and post-fix access-control validation.

## 1) Prisma P3009 Repair (0006_add_collaborator_role_enums)

Status: completed

Actions taken:
- Inspected `_prisma_migrations` and confirmed failed row for `0006_add_collaborator_role_enums`.
- Verified schema/data already match expected enum role state:
  - enum types exist: `CollaboratorRole`, `SiteCollaboratorRole`
  - role columns are USER-DEFINED enums with correct default `collaborator`
  - existing role values are valid (`admin`, `collaborator`)
- Applied Prisma-supported metadata repair:
  - `prisma migrate resolve --applied 0006_add_collaborator_role_enums`
- Verified clean migration state:
  - `prisma migrate deploy` => no pending migrations
  - `prisma migrate status` => database schema up to date

Notes:
- Original failure cause in migration logs was permission ownership error (`must be owner of table Collaborator`) during earlier apply attempt.
- No tables dropped, no data deleted, no DB recreation.

## 2) Platform Admin Detection Restore

Status: completed

Actions taken:
- Updated managed Coolify app env file at `/data/coolify/applications/dt0v391xre5rgtp50062tunm/.env`.
- Added:
  - `BOOTSTRAP_ADMIN_EMAIL=devkev@manifestfts.com`
- Recreated app container via compose in that app directory to apply env change.
- Verified runtime env in running container includes:
  - `NEXTAUTH_URL=https://jongo.manifest-fts.com`
  - `BOOTSTRAP_ADMIN_EMAIL=devkev@manifestfts.com`
- Verified normalized email match in production users:
  - `lower(trim(email)) = devkev@manifestfts.com` exists for active user.

## 3) Production Site Mapping Sync (Safe, No Guessing)

Status: no writes performed (review report mode)

What was checked:
- Coolify applications were joined to Coolify projects by resolving `environment_id -> project environments`.
- Production DB organizations were checked against mapping keys:
  - `Organization.coolifyProjectId`
  - `Organization.coolifyProjectName` and `Organization.name`

Result:
- Deterministic match count: 0 applications matched to existing DB organizations.
- Unmatched application count: 30.
- Because ownership is currently ambiguous relative to existing DB organizations, no `Site` rows were inserted to avoid mis-assignment.

Unmatched project buckets (apps grouped by Coolify project):
- FTS Ventures (13)
- Uncategorized (4)
- Umar Farooq (2)
- Manifest FTS (2)
- Rudy Zeigler (2)
- Daniel Kane (2)
- Emile De Meyer (1)
- Millenion Fitness (1)
- Community Catalyst (1)
- JoyFeed (1)

Current DB inventory after checks:
- Organizations: 2
- Sites: 0
- Site collaborators: 0

Required follow-up before safe auto-create:
- Confirm mapping from Coolify projects above to intended Jongo organizations (or create corresponding organizations first).
- After mapping is defined, run insert-only sync that creates missing `Site` rows and does not overwrite existing mappings.

## 4) Access-Control Matrix Re-Run (Post-Fix)

Status: rerun completed with current production fixtures

Results:
- Platform admin env detection restored: PASS
- Migration health gate (`prisma migrate deploy` clean): PASS
- Platform admin sees all clients: PASS (effective via ownership/collaborator data)
- Platform admin sees all apps: FAIL (no `Site` rows exist yet)
- Client member sees only their client: PASS (`lot6six@gmail.com` scoped to `Kevin Adams` only)
- Client member app visibility by tenant: BLOCKED by data gap (0 sites)
- App collaborator visibility scenarios: BLOCKED by data gap (0 site-collaborator rows)
- Direct URL fail-closed behavior: PASS by unchanged scoped repository/page guards

## Guardrails Preserved

- No feature expansion.
- No fail-open rollback.
- No global fallback reintroduced for scoped users.
- No data-destructive operations performed.
