# Database Schema — Phase 1

All tables use `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` unless noted.

## Core Tables

### users
Essential user and identity.

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  email_verified BOOLEAN DEFAULT FALSE,
  email_verified_at TIMESTAMP,
  password_hash VARCHAR(255),
  full_name VARCHAR(255),
  avatar_url TEXT,
  auth_provider VARCHAR(50), -- 'local', 'github', 'google', etc.
  auth_provider_id VARCHAR(255), -- external provider ID
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP -- soft delete
);
```

### organizations
Organizational units. Each organization owns sites and manages collaborators.

```sql
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(255) UNIQUE NOT NULL, -- for URLs
  name VARCHAR(255) NOT NULL,
  description TEXT,
  logo_url TEXT,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  coolify_api_url TEXT, -- optional: override base URL for this org
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);
```

### sites
Applications/projects. Each site belongs to one organization.

```sql
CREATE TABLE sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  coolify_service_id VARCHAR(255), -- external Coolify service ID
  coolify_service_uuid VARCHAR(255), -- Coolify service UUID
  git_repository_url TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP,
  UNIQUE(organization_id, slug)
);
```

### environments
Deployment targets: production, staging, development, etc.

```sql
CREATE TABLE environments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL, -- 'production', 'staging', 'development'
  coolify_environment_name VARCHAR(255), -- maps to Coolify branch/environment
  is_production_like BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(site_id, name)
);
```

### deployments
Deployment records. Links to Coolify deployment data.

```sql
CREATE TABLE deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment_id UUID NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  coolify_deployment_id VARCHAR(255), -- external Coolify ID
  status VARCHAR(50), -- 'success', 'failed', 'in_progress', 'pending'
  triggered_by_id UUID REFERENCES users(id) ON DELETE SET NULL,
  triggered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP,
  finished_at TIMESTAMP,
  commit_sha VARCHAR(255),
  commit_message TEXT,
  logs_url TEXT, -- link to Coolify logs
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### collaborators
Team membership and permissions.

```sql
CREATE TABLE collaborators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL, -- 'owner', 'admin', 'operator', 'viewer'
  granted_by_id UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP,
  UNIQUE(organization_id, user_id)
);
```

### site_collaborators
Per-site permission overrides (optional; scope-refined access).

```sql
CREATE TABLE site_collaborators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL, -- 'admin', 'operator', 'viewer'
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP,
  UNIQUE(site_id, user_id)
);
```

### api_tokens
For programmatic access and integrations.

```sql
CREATE TABLE api_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255),
  last_used_at TIMESTAMP,
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMP
);
```

### audit_logs
Operational audit trail for compliance and debugging.

```sql
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL, -- 'deploy_triggered', 'site_created', 'collaborator_added'
  resource_type VARCHAR(50), -- 'site', 'deployment', 'collaborator'
  resource_id VARCHAR(255),
  details JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Indexes

```sql
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_organizations_owner_id ON organizations(owner_id);
CREATE INDEX idx_organizations_slug ON organizations(slug);
CREATE INDEX idx_sites_organization_id ON sites(organization_id);
CREATE INDEX idx_sites_coolify_service_id ON sites(coolify_service_id);
CREATE INDEX idx_environments_site_id ON environments(site_id);
CREATE INDEX idx_deployments_environment_id ON deployments(environment_id);
CREATE INDEX idx_deployments_status ON deployments(status);
CREATE INDEX idx_deployments_finished_at ON deployments(finished_at);
CREATE INDEX idx_collaborators_organization_id ON collaborators(organization_id);
CREATE INDEX idx_collaborators_user_id ON collaborators(user_id);
CREATE INDEX idx_site_collaborators_site_id ON site_collaborators(site_id);
CREATE INDEX idx_site_collaborators_user_id ON site_collaborators(user_id);
CREATE INDEX idx_api_tokens_user_id ON api_tokens(user_id);
CREATE INDEX idx_audit_logs_organization_id ON audit_logs(organization_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
```

## Notes

- All timestamps use UTC.
- Soft deletes via `deleted_at` for auditability.
- Foreign keys use ON DELETE CASCADE or ON DELETE SET NULL to avoid orphaning.
- `coolify_*` fields store external references for read/write operations.
- JSONB `details` column in audit_logs for flexible event data capture.
- API tokens store hashes, not plain tokens (security best practice).
