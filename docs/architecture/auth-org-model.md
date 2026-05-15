# Auth and Organization Model (Pass 1)

## Principles

- simple role model for MVP
- org and site scoped access controls
- no billing-driven role complexity
- clear upgrade path for future multi-server expansion

## Suggested MVP Roles

- `owner`: full org/site control, collaborator management
- `operator`: deployment and staging operations
- `viewer`: read-only environment and deployment visibility

## Suggested Core Entities

- `users`
- `organizations`
- `organization_memberships`
- `sites`
- `environments` (production, staging)
- `deployments`

## Ownership Mapping (Coolify -> Jongo)

### Terminology Contract

- Coolify `Project` -> Jongo `Client/Organization`
- Coolify `Application` / `Service` / `Database` -> Jongo `Site` (operational workspace)

### Mapping Rules

1. Coolify Project is the ownership boundary.
2. Jongo UI must present ownership as Client/Organization language, not Project-first language.
3. Imported resources inherit ownership from Coolify Project mapping automatically.
4. Orphan state is explicit when a Coolify resource has no mapped Client.

### Persistence

- Organization stores optional `coolifyProjectId` and `coolifyProjectName`.
- Site stores optional `coolifyProjectId` for resource-level traceability.
- Sync/import logic resolves Client assignment by project ID first, then project name.

### Orphan Fallback

- If Coolify project metadata exists but no Organization mapping exists -> mark as orphaned.
- If no project metadata is available from Coolify -> mark ownership unavailable and surface remediation in settings.

## Auth Direction

- session-based auth for web MVP
- server-side authorization checks per route/action
- capability checks at site/environment scope for deploy actions

## Deferred (Non-MVP)

- SSO/SAML
- enterprise policy engines
- fine-grained ABAC layers
