# Staging Workflow Design (Pass 1)

## MVP Workflows

1. production -> staging sync
2. staging -> production deploy
3. deployment and environment status visibility

## Workflow 1: Production to Staging Sync

- select site
- validate operator permissions
- trigger Coolify action for staging sync
- track progress and status updates
- mark result with timestamp, actor, and outcome

## Workflow 2: Staging to Production Deploy

- require explicit promotion action
- validate latest staging health checks
- trigger production deployment in Coolify
- record deployment event and actor metadata

## Visibility Model

- deployment timeline view
- environment health cards for production/staging
- simple action audit trail for collaboration context

## MVP Guardrails

- avoid advanced orchestration layers
- keep actions explicit and auditable
- fail-safe messaging on partial failures/timeouts
