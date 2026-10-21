# Coolify dashboard stalls — 2026-10-15

## Findings

- Dashboard: https://devops.manifest-fts.com/, Coolify v4.3.14.
- Control plane: root@5.78.204.111; application worker: 5.78.216.68.
- Control-plane containers healthy, disk 33% used, about 947 MiB available RAM, no active database waits or Redis blocked clients. Local login responses took 60–70 ms.
- Browser reproduced a blocking chart-script download taking 113 seconds over HTTP/3. Several Livewire response transfers also took 6–16 seconds. This points to delivery/transport rather than demonstrated server exhaustion; it does not establish a general HTTP/3 defect.
- Dashboard HTTPS router did not attach compression, although a compression middleware was defined. The chart script transferred 613,448 bytes uncompressed.
- DNS resolved directly to the control-plane IP; inspected responses were not Cloudflare-proxied.

## Applied mitigation

With operator approval, added `/data/coolify/proxy/dynamic/dashboard-performance.yaml` on the control-plane host. This is separate from Coolify's generated configuration.

- HTTPS router restricted to the dashboard hostname, excluding `/app` and `/terminal/ws` prefixes to preserve existing WebSocket routing.
- Router priority 100; existing `coolify@file` backend and Let's Encrypt resolver.
- Compression enabled via a dedicated middleware.
- Response header `Alt-Svc: clear` clears browser HTTP/3 advertisements for dashboard responses. HTTP/3 is not disabled globally.
- Traefik hot-reloaded the override; no containers were restarted or application code changed.
- Original generated routing backed up under `/data/coolify/proxy/backups/dashboard-performance-20261015T215258Z/`.

## Verification

- Public script response: `Content-Encoding: gzip`, `Alt-Svc: clear`; curl transfer reduced to 155,898 bytes (about 75% smaller).
- Fresh browser script request: HTTP/2, gzip, 155,219 encoded bytes, 1.47 seconds.
- Dashboard reload: DOM ready in 2.34 seconds, load event at 2.35 seconds (cached assets).
- Authenticated Projects navigation: 1.59 seconds; Servers navigation: 1.82 seconds.
- No proxy errors observed during application of the override.

## Rollback and follow-up

Remove the custom override from Traefik's watched dynamic directory to restore generated routing; no restart is required. Move it outside that directory if retaining a copy. Do not place YAML backups inside the watched directory.

Existing browser connections may need a full tab close/reopen to stop using the previous HTTP/3 connection. If stalls return, capture fresh request timings before changing server resources. Verify the override remains compatible after Coolify upgrades, hostname changes, or proxy replacement.