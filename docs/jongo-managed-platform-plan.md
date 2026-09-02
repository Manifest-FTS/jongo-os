# Jongo Managed Platform Plan

## Product Boundary

Jongo will have two related products operated by Manifest FTS:

- **Jongo Managed** is the future commercial storefront and customer portal at `jongo.app`. It sells domains and managed hosting, provisions paid customers into Coolify, and gives customers a simple operational view of their domains and services.
- **Jongo OS** is the existing open-source, self-hosted operations product in `Manifest-FTS/jongo-os`, currently deployed at `jongo.app`. Its deployment should move to `os.jongo.app` before `jongo.app` becomes the managed storefront.
- **Manifest FTS** is the legal entity, merchant of record, consultancy, enterprise-sales channel, and escalation path for custom support and delivery.

Jongo Managed must be an independent commercial product. Jongo OS remains open-source, self-hosted, provider-neutral, and free of commercial order, billing, registrar-resale, and customer-payment concerns.

## Repository Direction

The current `Manifest-FTS/jongo-os` deployment already serves an existing client at `jongo.app`. Do not disrupt that client or move its sign-in experience before the replacement portal is operational.

The preferred path is to keep `Manifest-FTS/jongo-os` as the open-source product and move its deployment to `os.jongo.app`. Duplicate that application in Coolify as an isolated starting point for **Jongo Managed**, then create a new private repository such as `Manifest-FTS/Jongo-app` from the duplicated application's code. The new repository and duplicated deployment become the managed `jongo.app` storefront and portal.

Coolify duplication is appropriate for the initial infrastructure copy, but it is not the repository split by itself. Before assigning `jongo.app` to the duplicate, change its Git source to the new private repository, give it separate environment secrets and database resources, confirm it has no production-domain conflicts, and deploy it on a temporary validation hostname. Only then switch `jongo.app` DNS and remove that hostname from the Jongo OS deployment.

Before creating the fork or extraction, define and test these boundaries:

1. Move the current `Manifest-FTS/jongo-os` Coolify application from `jongo.app` to `os.jongo.app`; add and validate the new DNS record and TLS certificate before removing the old names.
2. Duplicate the Coolify application only as a starting point, then detach the duplicate from shared state: new private Git repository, database, credentials, webhook identity, storage, backups, and non-production validation domain.
3. Extract or isolate provider-neutral interfaces for Coolify, DNS verification, telemetry, audit, and reconciliation.
4. Keep managed-customer data, commercial pricing, orders, payment workflows, Porkbun credentials, registrar events, and private support tooling in the new private Jongo Managed repository.
5. Maintain a compatibility and cutover plan for the existing Jongo client before assigning `jongo.app` to the managed portal.

Until those gates are met, the current `Manifest-FTS/jongo-os` repository and deployment remain the open-source product, even while it temporarily uses `jongo.app`. The new managed repository is created only after the Coolify duplicate is isolated and validated.

## Launch Offerings

### Domains

- Search, availability, quote, registration, renewal, and transfer-in.
- Managed DNS, DNS verification, DNSSEC where supported, and URL forwarding.
- Optional Cloudflare connection after customer authorization and verification.
- Managed TLS for hosted services.
- Customer-visible renewal, transfer, DNS, and registrar-status history.

Domains initially live in a Manifest FTS-managed Porkbun account. Customers should be the registrant where the TLD permits it and must have a documented, supportable transfer-out path.

### Managed Hosting

Jongo Managed supports the workloads Coolify supports and Manifest FTS can operate safely, including:

- WordPress and other CMS workloads.
- Next.js, React, Node.js, and static web applications.
- Other containerized applications supported by Coolify after an operator validates the build, runtime, data, backup, monitoring, and support requirements.

The first automated provisioning template should be WordPress because it is already closest to the current Jongo provisioning path. Next.js/React and other Coolify workloads should follow through tested, workload-specific templates rather than an unbounded "deploy anything" promise.

## Initial Pricing

| Plan | Price | Intended service |
| --- | ---: | --- |
| Managed Hosting | $45/month | Managed hosting for an approved Coolify workload, managed TLS/DNS, deployment visibility, backup monitoring, and standard support. |
| Managed Hosting with Micro SLA | $149/month | Managed Hosting plus a defined micro SLA, priority response, staging/operational assistance, and enhanced monitoring/backup support. |
| Enterprise / Organization | Custom | Larger teams, multiple services, higher resource needs, custom architecture, and a full negotiated SLA. |

Domain registration, renewal, and transfer charges are separate from hosting. Show the registrar price, any Jongo management fee, billing term, renewal date, and applicable tax before purchase. Exact resource allowances, included usage, management fee, micro-SLA response targets, full-SLA terms, support hours, overages, and refund policy require commercial and legal review before publication.

## Explicitly Deferred

The first release does not offer:

- A public marketplace for Manifest FTS-owned domains.
- Auctions, closeouts, expired-domain inventory, or third-party aftermarket listings.
- Email mailbox hosting.
- Generic unmanaged VPS resale.
- Automated support for untested Coolify workload types.

A future domain marketplace is a separate business capability. It requires ownership verification, escrow or transfer mechanics, fraud controls, tax and consumer-policy handling, disputes, and clear marketplace terms.

## Partner Integration: Porkbun

Porkbun is the proposed registrar and initial DNS integration. Its API supports domain availability and pricing, registration, renewal, transfers, contacts, nameservers, DNS/DNSSEC, forwarding, email forwarding, SSL bundles, signed webhooks, idempotency keys, dry runs, a sandbox, and Cloudflare connection workflows.

Before accepting payment or registering a customer domain:

1. Obtain written confirmation that the Manifest FTS master-account and customer-registrant model is permitted under Porkbun's current terms.
2. Define registrant-contact collection, TLD-specific eligibility validation, WHOIS privacy exceptions, transfer-out, renewal notices, abuse reporting, refund/chargeback handling, taxation, and data-processing obligations.
3. Use Porkbun sandbox credentials to validate quotes, registration requirements, dry-run registration, DNS updates, webhook verification, idempotency replay, and reconciliation.
4. Restrict production API keys by source IP and domain scope. Keep all provider credentials server-side.

Treat Cloudflare as an opt-in, customer-authorized integration. Launch with a verified Porkbun DNS workflow if Cloudflare account ownership, authorization, migration, and rollback are not yet proven.

## Provisioning Workflow

The commercial workflow must be asynchronous, idempotent, auditable, and resumable:

1. Search a domain or select hosting-only onboarding.
2. Retrieve availability, current price, term, and TLD registration requirements.
3. Collect and validate registrant details and customer eligibility.
4. Authorize payment and create a commercial order in `pending` or `manual-review` state.
5. Register or transfer the domain through Porkbun, using a provider idempotency key.
6. Create the commercial customer record and Jongo organization.
7. Create a Coolify project, production environment, and workload-specific application/database resources.
8. Apply DNS records or Cloudflare connection, then verify propagation and TLS.
9. Configure the applicable backup, monitoring, access, and portal baseline.
10. Reconcile observed provider state, mark the order `active`, and hand off the service to the customer.

The workflow must surface `pending`, `manual-review`, `provisioning`, `active`, and `failed-with-remediation` states. It must never create duplicate domains, charges, Coolify projects, or applications after retries. Compensating cleanup applies only to resources created by the failed order; existing or customer-linked resources are never deleted automatically.

## Commercial Platform Interfaces

Implement commercial integrations behind server-side provider contracts:

- `RegistrarProvider`: availability, quotes, registration, renewals, transfers, contacts, privacy, and nameservers.
- `DnsProvider`: zones, records, verification, DNSSEC, and Cloudflare connection state.
- `HostingProvisioner`: Coolify project, environment, application, database, deployment, and domain lifecycle.
- `BillingProvider`: checkout, authorization, invoices, recurring plans, refunds, and payment webhooks.
- `ProvisioningOrchestrator`: durable workflow state, retries, idempotency, compensations, provider events, and reconciliation.

Persist provider request IDs, idempotency keys, quoted price/currency/expiry, external resource IDs, desired and observed state, lifecycle events, operator interventions, and customer-visible audit history. Browser clients never receive provider API credentials.

## Portal Surfaces

### Customer Portal

- Domain inventory, registration/transfer/renewal status, and renewal controls.
- DNS records, verification tasks, forwarding, and Cloudflare connection status.
- Application health, deployment history, staging where included, backups, and service notices.
- Plans, invoices, payment method, team access, support requests, and activity history.

### Manifest FTS Operator Console

- Order and manual-review queue.
- Provisioning progress, retries, webhook failures, and reconciliation exceptions.
- Coolify project/resource mapping and workload-template validation.
- Registrar spend, expiring domains, renewal risk, transfer-out, and abuse workflows.
- Audited support access and customer lifecycle management.

## Jongo OS Relationship

Only proven, provider-neutral operational capabilities should flow from Jongo Managed back into Jongo OS:

- Coolify project, environment, and application provisioning interfaces.
- DNS desired-versus-observed state and domain-verification contracts.
- Telemetry, audit, reconciliation, and lifecycle-state primitives.

Keep Porkbun resale logic, customer PII, billing, pricing, commercial orders, account-level provider secrets, and managed-service support tooling proprietary and outside Jongo OS.

## Delivery Phases

1. **Domain and repository separation:** validate `os.jongo.app`, move the existing `Manifest-FTS/jongo-os` deployment there, duplicate its Coolify application, create a private `Jongo-app` Git repository, detach duplicate state, and validate it on a temporary hostname before any `jongo.app` cutover.
2. **Partner proof:** complete Porkbun resale due diligence and sandbox integration; create provider interfaces and webhook verification.
3. **Operator-first provisioning:** create Coolify project/environment/application templates, order state, reconciliation, and a staffed manual-review workflow.
4. **Managed WordPress launch:** release domain purchase/transfer, WordPress provisioning, DNS/TLS, the $45 and $149 plans, and the customer portal.
5. **Approved workload expansion:** add Next.js/React and additional Coolify workload templates only after repeatable provisioning and support acceptance tests.
6. **Open-source extraction:** publish or fork Jongo OS after its provider-neutral boundary is independently installable and commercial code is isolated.

## Acceptance Gates

- Porkbun confirms the intended commercial custody and resale model in writing.
- A sandbox order completes availability, quote, requirements validation, dry-run registration, DNS update, webhook verification, idempotency replay, and reconciliation.
- A production-like test completes payment authorization through a new Coolify project, workload provisioning, DNS/TLS verification, backup baseline, and customer-portal visibility.
- Failed-domain, provider-timeout, duplicate-webhook, failed-payment, and retry paths leave no duplicate billable or infrastructure resources.
- Micro-SLA and full-SLA commitments, support ownership, backup/restore responsibility, transfer-out policy, and customer terms are approved before public purchase is enabled.