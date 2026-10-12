# Custom staging domains

Status: **implemented** (approved 2026-10-12). Pure logic in `apps/web/src/lib/staging-domain-rules.ts`, `staging-domain-claims.ts`, `staging-dns-check.ts`, `staging-ssl-check.ts`, `staging-primary-url.ts`; I/O in `staging-domains.ts`, `staging-dns-lookup.ts`, `staging-ssl-probe.ts`.

## Goal

Let a client use their own hostname for staging (`staging.clientsite.com`) instead of
`site.stage.mfts.link`. Jongo shows the exact DNS record to create, verifies it, attaches
the hostname to the staging resource in Coolify, reports the certificate, and uses the
custom hostname as the staging link everywhere. The `.mfts.link` host stays attached and
always works.

Today `StagingDomainForm.tsx` sends free text straight to Coolify (`PATCH /staging`), with
no ownership or DNS check and no SSL status, which is why staging links on client domains
can be broken (see the trade-off in `lib/stage-domain.ts`).

## Decisions (agreed)

| Topic | Decision |
|---|---|
| Plans | Available on **all plans** for now. No plan gate: plans are not recorded per client/site yet. Revisit when plans are enforced. |
| DNS record | **CNAME** `staging.clientsite.com` → the site's fallback host (`site.stage.mfts.link`). An **A record** to the same IP is accepted for DNS hosts that cannot CNAME. |
| Cloudflare proxy | **DNS-only required.** A proxied (orange-cloud) record is detected and the client is told to switch it to grey. |
| Permission | **Client admins only** (`canEditDomains`), same as production domains. |
| Limit | **2 custom domains per site.** |
| Apex | Subdomains only (`staging.client.com`). An apex cannot be a CNAME and is the client's production name. |

Facts checked while designing:
- `*.stage.mfts.link` is DNS-only and resolves straight to the server (5.78.216.68), so a client CNAME to it reaches Traefik and Let's Encrypt can issue. The expected IP is read by resolving the fallback host, so no server IP needs configuring (`STAGING_TARGET_IPS` overrides).
- No staging resource uses a client domain today (all are `mfts.link` / `manifest-fts.com`), so nothing to migrate.

## Lifecycle

```
add ─▶ pending_dns ──verify ok──▶ verified ──attach ok──▶ active (ssl: pending ─▶ issued | failed)
          │  ▲                                                │
          │  └──────────── DNS fixed (re-verify) ◀── dns_lost ◀┘ (hourly re-check)
          └─ verify fails: stays pending_dns, lastError + reason shown
remove (any state) ─▶ detached in Coolify ─▶ removed (row kept for audit, hostname freed)
```

- **Primary staging link** = the oldest custom domain that is `active` with SSL `issued`;
  otherwise the fallback host. A domain whose DNS or certificate breaks stops being primary
  automatically; nothing is deleted.
- **WordPress caveat.** WordPress redirects every host to its `home`/`siteurl`. When the
  primary changes (custom becomes active, or falls back), the staging database is rewritten
  from the old primary to the new one with the existing `runUrlRewrite`. Otherwise the
  fallback host would redirect visitors to a broken custom host.

## Data model

New table `StagingDomain` (additive migration):

| column | notes |
|---|---|
| `id` uuid | |
| `siteId` uuid → Site | the production site the staging belongs to |
| `hostname` text | normalised, lowercase, punycode |
| `status` text | `pending_dns` · `verified` · `active` · `dns_lost` · `failed` · `removed` |
| `sslStatus` text | `none` · `pending` · `issued` · `failed` |
| `cnameTarget` text | the fallback host shown in the instructions |
| `lastCheckedAt`, `verifiedAt`, `attachedAt`, `sslIssuedAt`, `sslExpiresAt`, `removedAt` | timestamps |
| `lastError`, `lastErrorReason` text | human message + machine reason (`cloudflare_proxied`, …) |
| `createdById`, `createdAt`, `updatedAt` | |

A **partial unique index** on `hostname WHERE status <> 'removed'` makes a duplicate claim
impossible at the database level, even under a race between two sites.

## Modules

Pure (fully unit-tested, no I/O):

| module | contract |
|---|---|
| `lib/staging-domain-rules.ts` | `normalizeHostname(input)`; `validateCustomStagingHostname(input, { platformSuffixes, productionHosts, knownTlds? })` → `{ ok, hostname }` or `{ ok:false, reason }` with reasons `empty · invalid · ip_address · wildcard · apex · platform_domain · production_domain · too_long`; `MAX_CUSTOM_STAGING_DOMAINS = 2`; `DEFAULT_BLOCKED_SUFFIXES = ["mfts.link","manifest-fts.com","jongo.app"]` |
| `lib/staging-domain-claims.ts` | `decideClaim(hostname, siteId, existing, { hostsInUseElsewhere, max })` → `ok` or `already_added · taken_by_other_site · in_use_elsewhere · limit_reached`. `removed` rows never count. |
| `lib/staging-dns-check.ts` | `evaluateDns(observation, { cnameTarget, targetIps })` → `{ ok:true, via:"cname"\|"a_record" }` or `{ ok:false, reason }` with `no_record · points_elsewhere · cloudflare_proxied · ipv6_mismatch · lookup_failed`; `isCloudflareIp(ip)` |
| `lib/staging-ssl-check.ts` | `evaluateCertificate(hostname, observation, { attachedAt, now })` → `issued · pending · failed` with reason `traefik_default_cert · name_mismatch · expired · unreachable · timed_out` (pending turns to failed after 30 min) |
| `lib/staging-primary-url.ts` | `resolvePrimaryStagingHost({ fallbackHost, customDomains })` → `{ host, source }`; `stagingHostsForRewrite(...)` → every host staging content may reference, primary first |

I/O (thin wrappers, tested with the pure functions doing the deciding):
- `lib/staging-dns-lookup.ts`: resolves CNAME/A/AAAA through public resolvers (1.1.1.1, 8.8.8.8), not the server's cache, into a `DnsObservation`.
- `lib/staging-ssl-probe.ts`: TLS handshake with SNI, returns a `CertificateObservation`.
- `lib/staging-domains.ts`: orchestrates add / verify / attach / remove / reconcile, writes audit log entries (`staging_domain_added`, `…_verified`, `…_attached`, `…_removed`, `…_dns_lost`).

## Coolify attach / detach

- **Attach:** desired hosts = fallback + every `active`/`verified` custom domain →
  `applyCoolifyServiceDomains` (WordPress services) or `applyCoolifyApplicationDomains`
  (apps) → restart, so Traefik regenerates its routers and requests the certificate. Then
  `active`, `sslStatus: pending`.
- **Detach:** the same call without the hostname → restart. The fallback is always in the
  desired list, so it can never be removed by this path.
- If Coolify refuses, the domain stays `verified` with the error shown, and the next
  reconcile retries.

## "Use it everywhere"

One resolver (`resolvePrimaryStagingHost`) replaces the ad-hoc `capability.stagingUrl ?? fqdn.split(",")[0]` reads in:
- staging page and `StagingSiteFacts` (link + "open staging");
- notifications (`notifyStagingCreated`, promote / sync emails);
- `StagingAuditHistory` (shows the URL that was live at the time, stored on the audit entry);
- **promote (staging → production) URL rewrite**: rewrites *every* staging host
  (`stagingHostsForRewrite`) to the production URL, so content edited under either host is
  fixed;
- **sync (production → staging)**: rewrites production to the current primary host.

## API

All under `/api/sites/[siteId]/staging/domains`, all requiring `canEditDomains`:

| method | path | does |
|---|---|---|
| GET | `/domains` | list with status, SSL, the record to create, primary flag |
| POST | `/domains` `{ hostname }` | validate + claim → `pending_dns` |
| POST | `/domains/[id]/verify` | DNS check; on success attach in Coolify. Rate-limited to one check per 15 s per domain |
| DELETE | `/domains/[id]` | detach in Coolify, mark `removed`, rewrite WordPress back if it was primary |

The free-text `domains` branch of `PATCH /staging` is removed. `StagingDomainForm.tsx` is replaced by `StagingDomainsPanel.tsx` (add → record card with copy buttons → Verify → status chips: DNS, SSL, Primary).

## Hourly reconcile

Added to the existing backup-reconcile pass, at most 10 domains per run:
- `active`: re-check DNS (→ `dns_lost` if the record is gone or changed) and the certificate
  (record `sslExpiresAt`; `failed` if Traefik is still serving its default certificate after
  30 minutes).
- `dns_lost`: re-check; back to `active` when DNS returns.
- `verified` (attach failed): retry the attach.

## Abuse protection

- Blocked suffixes: `DEFAULT_BLOCKED_SUFFIXES` + the platform suffixes already configured
  (`STAGING_DOMAIN_SUFFIX`, `PLATFORM_DOMAIN_SUFFIXES`), including the bare domains.
- A hostname another Coolify resource already serves (production of any client) is refused
  (`in_use_elsewhere`), using the reconciler's live resource index.
- 2 per site; partial unique index across the platform.
- Proof of control = the DNS record pointing at us. Nothing is attached before that, so
  nobody can make Traefik request a certificate for a hostname they do not control.

## Tests (written first, failing now)

| file | covers |
|---|---|
| `staging-domain-rules.test.ts` | normalisation (case, scheme, path, port, trailing dot, IDN), every rejection reason, multi-part TLD apex (`client.co.uk`), the per-site limit |
| `staging-domain-claims.test.ts` | duplicate claims across sites, re-adding on the same site, removed rows freeing a hostname, `in_use_elsewhere`, limit |
| `staging-dns-check.test.ts` | CNAME match (case/trailing dot), A-record fallback, Cloudflare proxy detection, points elsewhere, stray AAAA, NXDOMAIN and timeouts |
| `staging-ssl-check.test.ts` | issued, Traefik default cert = pending then failed after 30 min, wildcard SAN, name mismatch, expired, unreachable |
| `staging-primary-url.test.ts` | fallback when no custom domain is ready, custom only when `active` + SSL `issued`, oldest wins, `dns_lost`/`removed` fall back, rewrite host list |

## Out of scope (for now)

Plan gating, apex domains, proxied Cloudflare records, custom domains for production
(separate flow), wildcard staging hosts.
