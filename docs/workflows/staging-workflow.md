# Staging Workflow Design (Pass 1)

## MVP Workflows

1. production -> staging sync
2. staging -> production deploy
3. deployment and environment status visibility

## Workflow 1: Production to Staging Sync

- select site
- validate operator permissions
- confirm the action before any provisioning or destroy step runs
- trigger Coolify action for staging sync
- if Coolify supports domain updates, sync staging domains from Jongo as comma-separated values
- track progress and status updates
- mark result with timestamp, actor, and outcome

## Workflow 2: Staging to Production Deploy

- require explicit promotion action
- validate latest staging health checks
- trigger production deployment in Coolify
- block duplicate promote execution while a production deployment is already in progress
- record deployment event and actor metadata
- enforce confirmation phrase in UI/API before trigger executes
- block execution when staging-to-production preflight is locked
- poll latest production deployment status in staging workspace after trigger
- persist promote lifecycle outcomes (in progress/succeeded/failed) into staging audit history
- display a terminal-state banner on the staging page for the latest promotion outcome
- provide a manual refresh control for the live deployment status panel
- show started/completed timing for the latest production deployment result
- include a promote attempt correlation id in trigger response and audit timeline
- provide one-click copy for attempt id in staging promote surfaces

## Visibility Model

- deployment timeline view
- environment health cards for production/staging
- staging domain editor with Coolify sync feedback
- staging action audit trail with latest enable/disable/domain updates
- staging audit filter controls (all events vs domain sync)
- staging audit attempt-id filter controls (manual entry and latest-attempt shortcut)
- latest-attempt shortcut acts as a toggle for fast scope entry/exit
- staging page deep-link support (?attemptId=...) to open audit view pre-filtered by promotion attempt
- one-click copy action for attempt deep links in promote status surfaces
- active-filter indicator chip showing current audit filter scope (including attempt id)
- staging audit expand/collapse controls for deeper operator review
- staging audit export controls (copy or download filtered history as text or JSON with filter context labels)
- simple action audit trail for collaboration context

## MVP Guardrails

- avoid advanced orchestration layers
- keep actions explicit and auditable
- fail-safe messaging on partial failures/timeouts
