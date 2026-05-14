# Architecture Discovery (Pass 1)

## Goal

Identify reusable architecture from legacy Jongo while removing SaaS-specific assumptions.

## Reuse Candidates from Legacy `jongo`

- monorepo shape with `apps/` and `packages/`
- Next.js app-router web surface
- deployment and ops mindset from existing docs and scripts

## Explicit Exclusions

- Stripe and billing workflows
- SaaS subscription objects and payment webhooks
- reseller and white-label requirements
- hosted multi-tenant monetization concerns

## Pass 1 Decisions

- start with one web app in `apps/web`
- scaffold route surface before implementing backend integrations
- build API/service boundaries for Coolify integration first

## Next Discovery Work

- inspect legacy auth and org permission patterns for reusable concepts
- evaluate which domain objects become MVP primitives (org, site, env, deploy, collaborator)
- define clear service interfaces between UI and Coolify API integration layer
