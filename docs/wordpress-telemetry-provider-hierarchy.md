# WordPress Telemetry Provider Hierarchy

This document describes the default telemetry strategy for self-hosted Jongo users running Coolify-managed WordPress sites.

## Goals

- Do not require a custom plugin for baseline plugin/theme/core visibility.
- Prefer first-party platform inspection for Coolify-managed sites.
- Keep plugin-based and external collector paths optional.

## Preferred Provider Order

1. Platform-level inspection
2. Secure WordPress REST (application passwords)
3. Optional mock/test provider
4. Optional upstream collector/plugin-enhanced provider

## Provider Details

### 1) Platform-Level Inspection (Preferred)

Target sources for Coolify-managed WordPress resources:

- WP-CLI in running container
- WordPress filesystem metadata
- Container/env/runtime metadata

Status:

- Provider hook exists in bridge pipeline.
- Full WP-CLI/container implementation is planned incrementally.

### 2) REST Application Password Provider (Default Fallback)

When platform inspection is not available, configure per-site REST credentials:

```dotenv
WORDPRESS_TELEMETRY_REST_SITE_MAP={"waterfallkeepersofnc-org":{"siteUrl":"https://waterfallkeepersofnc.org","username":"telemetry-bot","appPassword":"xxxx xxxx xxxx xxxx xxxx xxxx"}}
WORDPRESS_TELEMETRY_REST_TIMEOUT_MS=5000
```

Notes:

- Key map by site slug/site id used in Jongo.
- Use least-privilege WordPress user for telemetry.
- REST provider populates plugin counts and tabular plugin rows when endpoint permissions allow.

### 3) Mock Provider (Testing)

Optional for local or staging verification:

```dotenv
WORDPRESS_TELEMETRY_COLLECTOR_MOCK_DATA={"waterfallkeepersofnc-org":{"activePlugins":28,"inactivePlugins":5,"updatesAvailable":2,"securityIssues":0,"coreVersion":"6.5.5"}}
```

### 4) Optional Upstream Collector

Advanced extension for custom telemetry systems or deep plugin-assisted metrics:

```dotenv
WORDPRESS_TELEMETRY_COLLECTOR_UPSTREAM_URL=https://example.com/collector/wordpress
WORDPRESS_TELEMETRY_COLLECTOR_UPSTREAM_TOKEN=<token>
WORDPRESS_TELEMETRY_COLLECTOR_UPSTREAM_TIMEOUT_MS=5000
```

This path is optional and not required for baseline Coolify-managed WordPress telemetry.

## Required Core Bridge Settings

```dotenv
WORDPRESS_TELEMETRY_COLLECTOR_URL=https://<your-jongo-host>/api/internal/wordpress-collector
WORDPRESS_TELEMETRY_COLLECTOR_TOKEN=<shared-bridge-token>
WORDPRESS_TELEMETRY_COLLECTOR_BRIDGE_ENABLED=true
WORDPRESS_TELEMETRY_COLLECTOR_TIMEOUT_MS=5000
```

## Security Guidance

- Keep tokens and app passwords server-side only.
- Never expose telemetry credentials in client code.
- Rotate REST app passwords and bearer tokens periodically.
- Restrict WordPress telemetry users to only required capabilities.
