# Local Development With A Secure DB Tunnel

Jongo OS can read real client data from the Coolify-hosted Postgres database during local development, but it must do so through an SSH tunnel. The database hostname in Coolify is only resolvable inside the Coolify Docker network, so Windows or Git Bash on your workstation cannot connect to it directly.

The Windows tunnel must point at a database endpoint the Hetzner host can already reach. Do not use the Coolify-internal container hostname in the SSH `-L` target. Use a host-local bind such as `127.0.0.1:5432` on the Hetzner machine, or another target that is reachable from the host itself.

## Why the internal host fails locally

The production `DATABASE_URL` uses the internal Coolify service hostname:

`o4g2cpls648gnz0f1he7be7c:5432`

That host only exists inside the container network. From a local Windows machine it will fail with errors such as `ENOTFOUND`, `ECONNREFUSED`, or `ETIMEDOUT`, and the app will fall back to mock client data.

## How SSH tunneling works

An SSH tunnel forwards a local port on your machine to the remote Postgres port on the Coolify server. Jongo OS then talks to `localhost:5433` as if Postgres were running locally, while the traffic is still encrypted and forwarded through SSH.

Local development should use this format:

```env
DATABASE_URL=postgresql://postgres:hsWWv5p6dPmuWoVhwYOKaEcB3aGFuVERhF7fjr3Wz6VZQnSGXhFzno0aAcZsPAIk@localhost:5433/postgres
```

Keep the production/internal URL unchanged inside Coolify. Only your local `.env.local` should point at `localhost:5433`.

There are two env-loading paths in this repo:

- `apps/web/.env.local` is read by the Next.js web app when you run `npm run dev:web` or `npm run dev`.
- repo-root `.env.local` is read by the wrapper scripts `npm run dev:web:env` and `npm run start:web:env`.

Keep both files in sync locally if you use both entrypoints. The database URL should be the tunnel URL in either case.

## What target should the SSH tunnel use?

Use a target the Hetzner host can reach directly:

- safest option: a localhost-only bind on the Hetzner host, such as `127.0.0.1:5432`
- acceptable option: a Docker bridge or published host port that the host can reach
- avoid: Coolify app-network service names like `o4g2cpls648gnz0f1he7be7c`, which only resolve inside the container network

If the database is managed by Docker on the Hetzner host, the container name is usually the service name from the compose file. In this repo’s local Docker path, that is `db` and the container name is `jongo-os-db`, but the live Coolify deployment may use different names.

If you have shell access on the Hetzner host, inspect the actual container and network with:

```bash
docker ps --format "table {{.Names}}\t{{.Ports}}\t{{.Networks}}"
docker inspect <postgres-container-name> --format '{{json .NetworkSettings.Networks}}'
docker inspect <postgres-container-name> --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
```

If the host already publishes Postgres on localhost only, prefer that port in your SSH tunnel target. If not, add a host-local bind in the deployment configuration first; that is safer than exposing Postgres publicly.

## Windows PowerShell

Start the tunnel in a dedicated terminal and keep it open:

```powershell
ssh -L 5433:127.0.0.1:5432 root@<SERVER_IP>
```

If you want a wrapper, use the helper script in this repo:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\db-tunnel.ps1 -ServerHost <SERVER_IP> -RemoteHost 127.0.0.1 -RemotePort 5432
```

If the Hetzner host uses another localhost-only bind for Postgres, replace `127.0.0.1:5432` with that host-side target.

## Git Bash

Git Bash uses the same SSH command:

```bash
ssh -L 5433:127.0.0.1:5432 root@<SERVER_IP>
```

## Recommended local workflow

1. Start the tunnel.
2. Set `apps/web/.env.local` and, if you use the wrapper scripts, repo-root `.env.local` to the `localhost:5433` `DATABASE_URL` shown above.
3. Run `npm run dev:web` or `npm run dev:web:env`.
4. Open `/organizations` and confirm real client data appears instead of mock data.

## Troubleshooting

- If you still see mock client data, verify the tunnel terminal is still running.
- If the app logs `ENOTFOUND`, the local `DATABASE_URL` is still pointing at the internal Coolify hostname or the host-side SSH tunnel target is wrong.
- If the app logs `ECONNREFUSED`, the tunnel is not listening on `localhost:5433` or another process already occupies that port.
- If the app logs `ETIMEDOUT`, the SSH session cannot reach the remote server or the remote Postgres port is not reachable from the Coolify network.
- If the app logs Prisma `P2023` (`Error creating UUID`), your session identity is likely non-UUID (for example a stale local dev session). Sign out, clear auth cookies, and sign in again so the session user ID comes from the DB UUID.
- If the app logs a schema or query error after the connection succeeds, the issue is no longer the tunnel. Check migrations or the affected repository query.
- The server logs should show a targeted warning from `apps/web/src/lib/db.ts` when connectivity fails, including the host currently in `DATABASE_URL`.