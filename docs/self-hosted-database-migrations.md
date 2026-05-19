# Self-Hosted Database Migrations

Jongo OS uses committed Prisma migrations as the only normal schema change workflow.

## Rules

- Schema changes must be represented by committed files in `prisma/migrations/`.
- Production and self-hosted deployments run `prisma migrate deploy` before the app starts.
- If migrations fail, the app process exits non-zero and does not start serving traffic.
- `prisma db push` is not part of the normal development, upgrade, or recovery workflow.
- Ad hoc SQL and `prisma migrate resolve` are advanced recovery tools only, after backup and investigation.

## Development Workflow

1. Update `prisma/schema.prisma`.
2. Create and apply a migration locally with `npm run db:migrate -- --name <migration_name>`.
3. Verify the app behavior against the migrated database.
4. Commit the schema change and generated migration directory together.

`prisma migrate dev` is the development path because it creates a real migration artifact that can be reviewed, committed, and deployed later with `prisma migrate deploy`.

## Production Startup Sequence

The canonical production command is `npm run start`.

It runs the following sequence:

1. `npm run prisma:generate`
2. `npm run db:migrate:deploy`
3. `npm run start:web`

This sequence is shared by:

- Generic Docker image startup
- Docker Compose self-hosted installs
- Nixpacks/Coolify deploys

Because the same command is used everywhere, self-hosted environments do not depend on Coolify-specific migration behavior.

## Deployment Guidance

- Build command: `npm run build`
- Start command: `npm run start`

On each deploy, the container starts only after committed Prisma migrations apply successfully.

## Self-Hosted Upgrades

Normal upgrade flow:

1. Back up the database.
2. Pull the new Jongo OS image or updated source release.
3. Redeploy using the normal container start command: `npm run start`.
4. Review container logs for the `[startup] Applying committed Prisma migrations...` step.
5. Confirm the application becomes healthy after migration completes.

Normal upgrades should not require SSH access to run SQL manually.

## Failure and Recovery

If startup fails during migration:

1. Inspect container logs for the Prisma error and migration name.
2. Run `npm run db:migrate:status` against the same database connection.
3. Verify database reachability, credentials, permissions, and whether another deploy is already applying migrations.
4. Restore from backup or use Prisma-supported repair only when the failure has been understood.

Advanced recovery notes:

- `prisma migrate resolve` may be appropriate for repairing Prisma migration metadata after a failed migration has already been applied safely.
- Manual SQL should be reserved for exceptional recovery cases, not routine upgrades.
- Do not use `prisma db push --accept-data-loss` as a shortcut for production fixes.