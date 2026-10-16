# TSK-01088 — isolated local database

## Resolved sign-in failure (2026-10-16)

The web environment pointed at `localhost:15433/postgres`, but there was no listener. The credentials callback mapped the database connection failure to `AUTH_DB_UNAVAILABLE` and returned 401. Auth variables were present; it was not an invalid-password error.

A read-only check through the restored tunnel also confirmed that the remote production database did not have the TSK-01088 schema. No remote migration was applied. With operator approval, the tunnel was stopped and replaced by an isolated PostgreSQL 17 cluster on the same loopback port. No environment credentials were printed or changed, and no production data was copied.

## Local setup

- Cluster: `%LOCALAPPDATA%/jongo-os/TSK-01088-local-db/data`.
- Listen: `127.0.0.1:15433`, password authentication (`scram-sha-256`).
- Uses the existing web environment's local database username/password and `DEV_AUTH_EMAIL` / `DEV_AUTH_PASSWORD` to create the development account.
- The explicit seed grants super only when that configured email is `devkev@manifestfts.com`. This is local development setup, not a production bootstrap bypass.
- Fresh schema created with Prisma `db push` only after verifying PostgreSQL's data directory equals this isolated cluster. This is not a migration-managed staging/production database. Use the separate migration harness to test deployment migrations.
- Empty domain/client/app inventory is expected. Production operations must not be tested with these local credentials or by reconnecting this branch to production.

Package commands: `db:local:setup` initializes once; `db:local:start`, `db:local:stop` and `db:local:status` control only this cluster. Start it again after reboot, then run the normal web dev process. Setup refuses an occupied port or existing cluster and never resets data.

Do not start an SSH tunnel on port 15433 while the local cluster is running. Root production-oriented environment files and migration wrappers remain unchanged; these local commands intentionally load the web environment. `PG_BIN` may override the PostgreSQL binary directory; the default is the installed Windows PostgreSQL 17 location.

Verified against the running local application: credentials callback returned **200**, redirected to `/dashboard`, and issued a session cookie. The local user has `super_admin`, and the current role/billing/domain schema is present. Secrets and cookie contents were not output.