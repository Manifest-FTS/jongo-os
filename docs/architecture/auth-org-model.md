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

## Auth Direction

- session-based auth for web MVP
- server-side authorization checks per route/action
- capability checks at site/environment scope for deploy actions

## Deferred (Non-MVP)

- SSO/SAML
- enterprise policy engines
- fine-grained ABAC layers
