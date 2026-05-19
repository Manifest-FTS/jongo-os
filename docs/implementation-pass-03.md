# Implementation Pass 03 — Phase 1 Foundation: Core Architecture

## Overview

Phase 1 establishes the complete product architecture for self-hosted deployment, using your Coolify infrastructure as the primary operational proving ground. This pass focuses on data models, database schema, authentication foundation, and environment configuration—the essential infrastructure for a universally deployable system.

## Completed

### Database and Domain Models
- Created comprehensive Prisma schema at [prisma/schema.prisma](../prisma/schema.prisma) mapping all Phase 1 entities
- Defined TypeScript domain types at [apps/web/src/types/domain.ts](../apps/web/src/types/domain.ts) for type safety across app
- Created detailed SQL schema documentation at [docs/database-schema.md](../database-schema.md)

### Domain Entities
- Users and authentication
- Organizations with multi-user collaboration
- Sites/Applications with multi-environment support
- Environments (production, staging, dev)
- Deployments linked to Coolify records
- Collaborators with role-based access (owner, admin, operator, viewer)
- Site-scoped collaborator overrides
- API tokens for programmatic access
- Audit logs for operational transparency

### Authentication Foundation
- NextAuth.js integration configured at [apps/web/src/lib/auth.config.ts](../apps/web/src/lib/auth.config.ts)
- Credentials provider (email/password) scaffolded
- Session and JWT token structure in place
- Callback hooks for user and organization context

### Database Client and Migrations
- Prisma Client wrapper at [apps/web/src/lib/db.ts](../lib/db.ts)
- Root package.json updated with db management scripts:
  - `npm run db:migrate` — create and apply migrations in dev
  - `npm run db:migrate:deploy` — deploy migrations in production
   - `npm run db:migrate:status` — inspect migration state for deploy/recovery checks
- Singleton pattern prevents multiple Prisma instances in dev

### Configuration and Environment
- Created `.env.example` documenting all Phase 1 parameters:
  - Application settings (NODE_ENV, NEXTAUTH_URL, NEXTAUTH_SECRET)
  - Database connection (DATABASE_URL, logging)
  - Coolify integration (API URL, token, timeout)
  - Storage backend (local or S3)
  - Email delivery (SMTP or SendGrid)
  - Logging and monitoring
  - Security settings (CORS, password policy, session timeout)
  - Feature flags
- All configuration is environment-based—no hardcoded paths or domains

### Dependencies Added
- `next-auth@5.0.0` — authentication framework
- `@prisma/client@5.21.0` — database ORM
- `prisma@5.21.0` — migrations and schema tools
- `bcryptjs@2.4.3` — password hashing

## Not Yet Done (Phase 1 Remaining)

### Authentication Implementation
- Wire Credentials provider to real user database
- Add password reset flow
- Implement email verification
- Add OAuth provider support (GitHub, Google)
- Create login and registration pages
- Add session/token expiration and refresh logic

### Data Access Layer
- Create repository/service functions for each domain entity
- Wire authentication to organization/site/collaborator access checks
- Implement role-based permission enforcement
- Add query scoping (users see only their org/sites/collaborators)

### API Routes and Server Actions
- Create server actions or route handlers for:
  - User registration and login
  - Organization CRUD
  - Site CRUD
  - Environment CRUD
  - Collaborator invite/remove/role change
  - Deployment triggers (read from Coolify)
- Wire Coolify overview API to use real database records

### Database Initialization
- Create seed script for initial setup
- Add migration to initialize schema
- Document database setup for first deployment

### Storage and Backup
- Implement storage abstraction (local/S3)
- Add backup scheduling logic
- Add restore validation

## Architecture Principles Locked

1. **Universally Parameterized**: All configuration via environment variables, compose files, config files—no hardcoded paths, domains, or secrets.
2. **Self-Hosted First**: Architecture assumes single-server deployment; designed to scale to multi-server via Coolify/Docker.
3. **Coolify-Driven**: Jongo is an operational UX layer on top of Coolify infrastructure, not a replacement.
4. **Role-Based Access**: Organizations and sites; owner/admin/operator/viewer roles with permission matrix.
5. **Audit Trail**: All actions logged for compliance and debugging.
6. **Portable**: Your Coolify deployment, another user's VPS, bare metal, Hetzner, Proxmox, DigitalOcean—all behave identically.

## Database Setup for Development

1. Create a PostgreSQL database:
   ```bash
   createdb jongo_dev
   ```

2. Copy `.env.example` to `.env.local` and update `DATABASE_URL`:
   ```bash
   cp .env.example .env.local
   # edit .env.local with your DATABASE_URL
   ```

3. Run migrations:
   ```bash
   npm run db:migrate -- --name init
   ```

4. Seed initial data (when available):
   ```bash
   npm run db:seed
   ```

## Environment Checklist for Phase 1

- [ ] DATABASE_URL set and database created
- [ ] NEXTAUTH_URL and NEXTAUTH_SECRET configured
- [ ] COOLIFY_API_BASE_URL and COOLIFY_API_TOKEN from your instance
- [ ] NEXTAUTH_SECRET rotated from default (dev-secret-change-in-production)
- [ ] Storage backend chosen (local or S3)
- [ ] Email backend configured (SMTP or SendGrid, or disabled in dev)
- [ ] SESSION_TIMEOUT_HOURS set appropriately

## Next Pass (Phase 1 Continuation)

1. Implement authentication workflows (registration, login, password reset)
2. Create data access services for each domain entity
3. Wire pages to database data instead of mocks
4. Add role-based access control to API routes
5. Implement Coolify write operations (deploy triggers, sync workflows)
6. Create first database migrations and seed script

## Testing Strategy

- Unit tests for domain logic (permissions, status mapping)
- Integration tests for authentication flows
- E2E tests for critical workflows (register → create org → invite user → trigger deploy)
- Manual testing on your Coolify infrastructure

## Notes

- The schema uses soft deletes (`deleted_at`) for auditability.
- All foreign key relationships cascade or set null appropriately to avoid orphaning.
- Indexes are placed on frequently queried columns (organization_id, user_id, status, created timestamps).
- JSONB `details` column in audit_logs allows flexible event capture without schema changes.
- API tokens store hashes, not plain tokens, for security.
