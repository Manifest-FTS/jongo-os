# SFTP Access — Architecture Decision

Investigated 2026-08-20 against the live host (5.78.216.68).

## Constraints found on the host

| Fact | Consequence |
|---|---|
| Site files live at `/var/lib/docker/volumes/<resourceUuid>_wordpress-files/_data` | The Coolify resource uuid Jongo already stores maps 1:1 to a volume. 16/16 sites follow it with no exceptions. |
| Files are owned by `www-data` = **uid 33 / gid 33**, and WordPress runs as uid 33 | Anything writing over SFTP must create files as 33:33, or WordPress cannot manage what the client uploads (and vice versa). |
| Host `sshd` owns port 22 | SFTP must use a separate port. Touching `sshd` risks locking everyone, including Jongo's own automation, out of the box. |
| UFW is active, allowing only 22, 80, 443, 6001, 6002 | Any SFTP port needs an explicit firewall rule — a deliberate, outward-facing change. |
| The volume is the full WordPress root, including `wp-config.php` | Whatever path a client is chrooted to decides whether they can read database credentials. |

## Options considered

**A. Per-site `atmoz/sftp` sidecar.** Strongest isolation — an OS boundary per client — but it is one container, one port and one firewall rule per site. At 16 sites that is 16 public ports, and every new site needs another. Rejected on operational cost.

**B. Host-level chrooted SSH users.** No new service, but `ChrootDirectory` requires root-owned parent directories, so each site's volume needs a bind-mount scaffold; it also means editing `sshd_config` on the box that Jongo itself depends on for backups, staging sync and privacy mode. Rejected: the failure mode is losing access to production.

**C. One SFTPGo instance, virtual users.** *Chosen.* A single container on a single port. Each user gets a `home_dir` pointing at that site's `_data`, and SFTPGo confines the session to it. Provisioning is a REST API, which is exactly what Subtask 2 needs — no shelling out, no host user management. Runs as 33:33 so uploads land with the ownership WordPress expects. `drakkan/sftpgo:v2` pulls cleanly on the host.

## Scope

**Per Coolify resource (per app), not per client and not per project.** A Jongo `Site` already maps to exactly one resource and therefore exactly one files volume, so this is the only level at which a home directory is unambiguous. A client with three sites gets three accounts — which is also what keeps one compromised credential from reaching the other two.

## Isolation

The container mounts `/var/lib/docker/volumes` (read-write) and nothing else — no Docker socket, no host root. Each user's `home_dir` is their own `_data` path, and SFTPGo denies traversal above it. Users are additionally given `denied_protocols: [FTP, WebDAV, HTTP]` so the account is SFTP-only.

The residual risk is honest and worth stating: one process can see every site's volume, so a container escape or an SFTPGo authorisation bug exposes more than a per-site container would. That is the trade accepted for a single port and API-driven provisioning. It is mitigated by running unprivileged (33:33), mounting only the volumes tree, and keeping the image current — not eliminated.

## Default path

Accounts are chrooted to the **WordPress root**, matching what managed hosts (Flywheel, WP Engine) give and what a client needs to work on themes and plugins. That includes `wp-config.php`, so the account holder can read the site's own database credentials — acceptable because those credentials only reach that site's database, which the same person already controls through wp-admin. Narrowing to `wp-content` is a one-line change in `buildSftpHomePath` if that trade is unwanted.

## Verified on the host, 2026-08-20

A throwaway SFTPGo was started, exercised and removed. Results:

| Check | Result |
|---|---|
| REST token via `/api/v2/token` | acquired |
| `POST /api/v2/users` | HTTP 201 |
| Real SFTP login (openssh client) | lists that site's WordPress root |
| Escape attempt — `cd ../../..` then `pwd` | reports `/`; the session cannot see the host filesystem or any other site |
| Upload | file created owned `www-data:www-data` (33:33), so WordPress can manage it |

The probe file was deleted and the container, its data directory and the test
user were removed; nothing was left behind.

## Deploy recipe

Two things cost time to discover and are not obvious from the image docs:

1. **SFTPGo needs a writable data directory of its own.** Running as `33:33`
   without one fails at startup with `unable to open database file`. Create the
   directory on the host and `chown 33:33` it.
2. **`SFTPGO_DEFAULT_ADMIN_USERNAME`/`PASSWORD` are ignored** unless
   `SFTPGO_DATA_PROVIDER__CREATE_DEFAULT_ADMIN=true` is also set. Without it the
   REST API answers every request with `401 invalid credentials`.

```bash
mkdir -p /var/lib/jongo-sftpgo && chown 33:33 /var/lib/jongo-sftpgo

docker run -d --name jongo-sftp --restart unless-stopped \
  --network coolify \
  -p 2222:2022 \
  -e SFTPGO_DATA_PROVIDER__CREATE_DEFAULT_ADMIN=true \
  -e SFTPGO_DEFAULT_ADMIN_USERNAME=jongoadmin \
  -e SFTPGO_DEFAULT_ADMIN_PASSWORD='<generate a strong one>' \
  -e SFTPGO_DATA_PROVIDER__NAME=/var/lib/sftpgo/sftpgo.db \
  -v /var/lib/jongo-sftpgo:/var/lib/sftpgo \
  -v /var/lib/docker/volumes:/srv/volumes \
  --user 33:33 \
  drakkan/sftpgo:v2

ufw allow 2222/tcp comment 'Jongo SFTP'
```

`--network coolify` is what lets Jongo reach the REST API by container name
without the admin port being public. Only 2222 is published.

Jongo then needs:

```
SFTPGO_API_URL=http://jongo-sftp:8080
SFTPGO_ADMIN_USERNAME=jongoadmin
SFTPGO_ADMIN_PASSWORD=<the same one>
SFTP_PUBLIC_HOST=5.78.216.68
SFTP_PUBLIC_PORT=2222
```

Until these are set, the dashboard card reports that SFTP is not configured and
the API refuses to provision rather than handing out credentials that cannot
work.

## Not done

- The container is **not deployed** and port 2222 is **not open**. Publishing a
  new internet-facing service and opening a firewall port is a deliberate
  security decision, so it is left to be made explicitly rather than as a side
  effect of building the feature.
- SSH-key auth. SFTPGo supports `public_keys` on a user, so adding a
  "download key" option later is additive; passwords cover the stated need.
- No reconciliation job. If someone deletes a user in SFTPGo directly, Jongo's
  row goes stale until the next provision or revoke.
