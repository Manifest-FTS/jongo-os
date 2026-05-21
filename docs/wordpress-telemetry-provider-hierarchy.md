# WordPress Telemetry Provider Hierarchy

This document describes the default telemetry strategy for self-hosted Jongo users running Coolify-managed WordPress sites.

## Goals

- Do not require a custom plugin for baseline plugin/theme/core visibility.
- Prefer first-party platform inspection for Coolify-managed sites.
- Keep plugin-based and external collector paths optional.

## Preferred Provider Order

1. Platform-level inspection
2. Saved app-level WordPress REST credentials (Connect Telemetry)
3. Optional env-map REST fallback for dev/testing
4. Optional mock/test provider
5. Optional upstream collector/plugin-enhanced provider

## Provider Details

### 1) Platform-Level Inspection (Preferred)

Target sources for Coolify-managed WordPress resources:

- WP-CLI in running container
- WordPress filesystem metadata
- Container/env/runtime metadata

Status:

- Provider hook exists in bridge pipeline.
- Full WP-CLI/container implementation is planned incrementally.

### 2) App-Level REST Credentials (Default Product Path)

Use App -> Integrations -> Connect Telemetry to save per-app credentials:

- WordPress site URL
- telemetry username
- WordPress application password

Notes:

- Passwords are encrypted server-side at rest.
- Passwords are never returned to the browser after save.
- Configuration and testing are admin-only actions.

### 3) Env-Map REST Fallback (Dev/Testing)

For temporary local/staging workflows, you can still use env mapping:

```dotenv
WORDPRESS_TELEMETRY_REST_SITE_MAP={"waterfallkeepersofnc-org":{"siteUrl":"https://waterfallkeepersofnc.org","username":"telemetry-bot","appPassword":"xxxx xxxx xxxx xxxx xxxx xxxx"}}
WORDPRESS_TELEMETRY_REST_TIMEOUT_MS=5000
```

Notes:

- Key map by site slug/site id used in Jongo.
- Use least-privilege WordPress user for telemetry.
- REST provider populates plugin counts and tabular plugin rows when endpoint permissions allow.

### 4) Mock Provider (Testing)

Optional for local or staging verification:

```dotenv
WORDPRESS_TELEMETRY_COLLECTOR_MOCK_DATA={"waterfallkeepersofnc-org":{"activePlugins":28,"inactivePlugins":5,"updatesAvailable":2,"securityIssues":0,"coreVersion":"6.5.5"}}
```

### 5) Optional Upstream Collector

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
