# Jongo QA Regression Checklist

Use this checklist monthly and after every major deployment release requested by team leads (Arun, Kevin). Execute it against new or dedicated, disposable QA projects wherever possible. Do not use a customer production site for destructive provisioning, promotion, backup, or teardown checks.

## Metadata And Execution Header

- [ ] Date tested: ____________________
- [ ] Jongo build / commit version: ____________________
- [ ] Tester name: Rod
- [ ] Test project name / slug: ____________________
- [ ] Production URL: ____________________
- [ ] Staging URL: ____________________
- [ ] Arun sign-off: ____________________

### Run Criteria

- [ ] Run this checklist once per month and after a deployment release requested by Arun or Kevin.
  - Expected: the run is dated, tied to a Jongo build or commit, and uses a unique test project slug.
- [ ] Before starting, confirm the Jongo operational layer, Coolify connection, DNS, and backup destination are reachable.
  - Expected: no unresolved platform incident prevents testing; record any exception below and mark affected checks as blocked rather than passed.
- [ ] Record evidence for failures or blocked checks, including the Jongo audit event or deployment ID, timestamp, URL, and relevant log excerpt.
  - Expected: Arun can reproduce or triage every non-pass outcome without relying on verbal handoff.

**Run result:** [ ] Pass  [ ] Fail  [ ] Blocked

**Failures, blockers, and evidence:**

________________________________________________________________________________

## Baseline Operational Layer

- [ ] Sign in as an authorized Jongo operator and open the test project's operational view.
  - Expected: the correct project, environment status, domains, resource identifiers, deployment history, and audit history are visible.
- [ ] Confirm Jongo uses the intended Coolify project and environment mappings for the test project.
  - Expected: production and staging are distinct Coolify project environments; no unrelated customer resource is shown or selectable.
- [ ] Trigger a harmless status refresh or reconciliation, then inspect the resulting status and audit entry.
  - Expected: status refresh completes without error, reflects the current provider state, and records actor, timestamp, action, and outcome.
- [ ] Verify failed or blocked operational actions surface a useful error state rather than reporting success.
  - Expected: the action is not silently accepted; the UI or API gives a retriable or remediation-oriented reason and records the outcome.

## Next.js / React Site Provisioning

- [ ] Create a new disposable Next.js or React site through Jongo using the test project name.
  - Expected: Jongo creates or links the intended Coolify project, production environment, application resource, and deployment record exactly once.
- [ ] Inspect the generated primary domain before and after deployment.
  - Expected: the primary URL is human-readable and follows `[project-name].mfts.link`; it does not expose a Coolify-generated random hash hostname as the primary URL.
- [ ] Open `http://[project-name].mfts.link` and follow its redirect behavior.
  - Expected: HTTP is reachable and redirects to HTTPS, or otherwise serves the platform's approved HTTPS-only behavior.
- [ ] Open `https://[project-name].mfts.link` in a browser and inspect the certificate.
  - Expected: the site loads without certificate warnings, the certificate covers the hostname, and the expected test page renders.
- [ ] Review the Jongo deployment status and Coolify deployment logs after provisioning.
  - Expected: the deployment reaches a successful terminal state; the application container is running and healthy with no restart loop.
- [ ] Reload the site and perform one basic application interaction appropriate to the test fixture.
  - Expected: responses are successful, static assets load, and no server error or client hydration error is visible.

## WordPress Site Provisioning

- [ ] Create a new disposable WordPress site through Jongo.
  - Expected: Jongo creates or links the intended production environment, WordPress resource, database resource, persistent storage, domain, and deployment record exactly once.
- [ ] Inspect the generated primary domain.
  - Expected: the primary URL follows `[project-name].mfts.link` and is not a Coolify-generated random hash hostname.
- [ ] Open `https://[project-name].mfts.link` and complete or view the WordPress initial setup page.
  - Expected: the page is reachable over valid HTTPS and no install, database, or PHP fatal error appears.
- [ ] Sign in to `https://[project-name].mfts.link/wp-admin` with the test administrator account.
  - Expected: WordPress admin loads, the dashboard is usable, and the session is scoped to the test instance.
- [ ] Create and publish a disposable test post, then view it publicly.
  - Expected: the post persists after reload and is visible on the public site, demonstrating WordPress-to-database connectivity.
- [ ] Verify the WordPress database resource is healthy using Jongo/Coolify status or an approved read-only health check.
  - Expected: the database is running, the WordPress site can read and write data, and no credentials or database resources are shared with another environment.
- [ ] Check the configured PHP upload profile from WordPress Site Health or an approved container command.
  - Expected: `upload_max_filesize` and `post_max_size` meet the platform default, currently `4G`; `memory_limit` is `1024M`; `max_execution_time` and `max_input_time` are `3600`.

## Staging Environment Lifecycle

- [ ] From the existing test production project, trigger creation of a Staging environment in Jongo.
  - Expected: the action completes without error and creates or links a distinct Coolify staging environment and staging resource.
- [ ] Inspect the staging URL after provisioning.
  - Expected: the URL is human-readable and follows `staging-[project-name].mfts.link`; it does not use a random hash hostname as the primary staging URL.
- [ ] Open the staging URL over HTTPS and verify its certificate.
  - Expected: staging is reachable with a valid certificate and renders the expected application or WordPress page.
- [ ] Compare Jongo/Coolify resource identifiers, environment variables, volumes, and database identifiers for staging and production.
  - Expected: staging and production use separate containers, persistent volumes, databases, credentials, and environment mappings; no staging action targets production resources.
- [ ] Make a disposable content or configuration change only in staging, then verify production remains unchanged.
  - Expected: the change is visible only at the staging URL before promotion.
- [ ] Review the staging lifecycle status and audit history.
  - Expected: creation, domain synchronization, health status, actor, timestamps, and any errors are visible and attributable to the test run.

## Staging-To-Production Promotion Workflow

- [ ] Confirm staging health checks pass and no production deployment is already running.
  - Expected: Jongo permits promotion only when preflight is healthy; a failed preflight blocks the action with a clear reason.
- [ ] Deploy a recognizable disposable change to staging, such as a visible copy change or non-secret configuration label.
  - Expected: the change is confirmed at the staging URL and is absent from production before promotion.
- [ ] Trigger **Promote to Production** in Jongo and complete its required confirmation.
  - Expected: Jongo records one promote attempt with an actor, timestamp, correlation or attempt ID, and in-progress status.
- [ ] Monitor the promotion to a terminal status in Jongo and Coolify.
  - Expected: deployment succeeds once; a repeated submission is blocked or idempotently replays the original attempt rather than starting a duplicate production deployment.
- [ ] Load the production URL after promotion and verify the test change.
  - Expected: the promoted change is visible on production and production otherwise remains functional.
- [ ] Reload key production routes or complete one critical test-fixture interaction after promotion.
  - Expected: production remains available over HTTPS with no unexpected error, redirect, database, or asset failure.
- [ ] Inspect the Jongo promotion audit history.
  - Expected: the final outcome, deployment timing, actor, and attempt identifier are recorded; failed or blocked outcomes include actionable context.

## Backup And Recovery Retesting

- [ ] Trigger a manual backup for the new production test environment.
  - Expected: the backup completes successfully, records a timestamp and resource identity, and produces a non-empty database export plus applicable site files.
- [ ] Trigger a manual backup for the new staging test environment.
  - Expected: the staging backup completes successfully and is associated with the staging resource, not production.
- [ ] Verify the newest production and staging backup artifacts are visible in the approved offsite restic/Backblaze B2 destination.
  - Expected: each artifact is present, non-empty, recent, identifiable by test project/environment, and reports no restic or B2 sync error.
- [ ] Perform an approved non-production restore verification for one test backup, or run the platform restore-test procedure where authorized.
  - Expected: the backup restores into an isolated target, core data is readable, and the restore target is removed afterward without touching production.
- [ ] Record observed backup age and restore duration.
  - Expected: backup freshness and restore time satisfy the current operational RPO/RTO target; if no target is defined, record the measurement for Arun's review.

## Teardown And Resource Cleanup

- [ ] Delete or tear down the disposable staging environment through Jongo.
  - Expected: the staging environment is removed from Jongo and Coolify; production remains reachable and unchanged.
- [ ] Confirm the staging domain no longer routes to a live test application.
  - Expected: the staging hostname no longer resolves to the deleted resource; any intended DNS retention behavior is documented.
- [ ] On the worker node, inspect Docker resources associated with the deleted staging project using approved operator access.
  - Expected: no orphaned staging application containers, database containers, networks, or persistent volumes remain, except explicitly retained backup artifacts.
- [ ] Inspect Traefik/Coolify routing configuration for the deleted staging hostname.
  - Expected: no active router, service, certificate request, or routing rule remains for the deleted staging resource.
- [ ] Verify Jongo marks the staging environment as deleted or absent and preserves an auditable teardown record.
  - Expected: the operational view does not report a healthy active staging environment after deletion, and the audit history identifies the teardown actor and outcome.
- [ ] Remove the disposable production test project only when it is no longer needed for follow-up investigation.
  - Expected: production teardown follows the same resource cleanup checks and is authorized by Arun before execution.

## Final Review And Sign-Off

- [ ] Confirm every applicable item is marked Pass, Fail, or Blocked; no unchecked item is treated as a pass.
  - Expected: the completed checklist accurately represents the executed scope.
- [ ] Create or update the incident/remediation record for each failed or blocked item.
  - Expected: each issue includes reproduction steps, expected versus actual result, evidence, severity, owner, and next action.
- [ ] Submit the completed checklist and evidence to Arun for review.
  - Expected: Arun signs off on a passing run or explicitly accepts the documented risk and remediation plan.

**Rod completion signature:** ____________________  **Date:** ____________________

**Arun sign-off:** ____________________  **Date:** ____________________