// Domain types for jongo-os
// Mapped directly to database schema

export type UUID = string & { readonly __brand: "UUID" };

// ============================================================
// Users and Authentication
// ============================================================

export type User = {
  id: UUID;
  email: string;
  emailVerified: boolean;
  emailVerifiedAt?: Date;
  fullName?: string;
  avatarUrl?: string;
  authProvider?: "local" | "github" | "google";
  authProviderId?: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
};

export type UserCreateInput = {
  email: string;
  fullName?: string;
  passwordHash?: string;
  authProvider?: string;
  authProviderId?: string;
};

export type Session = {
  userId: UUID;
  organizationId: UUID;
  email: string;
  role: "owner" | "admin" | "operator" | "viewer";
  expiresAt: Date;
};

// ============================================================
// Organizations
// ============================================================

export type Organization = {
  id: UUID;
  slug: string;
  name: string;
  description?: string;
  logoUrl?: string;
  ownerId: UUID;
  coolifyApiUrl?: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
};

export type OrganizationCreateInput = {
  slug: string;
  name: string;
  description?: string;
  logoUrl?: string;
  ownerId: UUID;
  coolifyApiUrl?: string;
};

export type OrganizationWithOwner = Organization & {
  owner: User;
};

// ============================================================
// Sites / Applications
// ============================================================

export type Site = {
  id: UUID;
  organizationId: UUID;
  slug: string;
  name: string;
  description?: string;
  coolifyServiceId?: string;
  coolifyServiceUuid?: string;
  gitRepositoryUrl?: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
};

export type SiteCreateInput = {
  organizationId: UUID;
  slug: string;
  name: string;
  description?: string;
  coolifyServiceId?: string;
  gitRepositoryUrl?: string;
};

export type SiteWithEnvironments = Site & {
  environments: Environment[];
};

// ============================================================
// Environments
// ============================================================

export type Environment = {
  id: UUID;
  siteId: UUID;
  name: string;
  coolifyEnvironmentName?: string;
  isProductionLike: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type EnvironmentCreateInput = {
  siteId: UUID;
  name: string;
  coolifyEnvironmentName?: string;
  isProductionLike?: boolean;
};

// ============================================================
// Deployments
// ============================================================

export type Deployment = {
  id: UUID;
  environmentId: UUID;
  coolifyDeploymentId?: string;
  status: "success" | "failed" | "in_progress" | "pending";
  triggeredById?: UUID;
  triggeredAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  commitSha?: string;
  commitMessage?: string;
  logsUrl?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type DeploymentCreateInput = {
  environmentId: UUID;
  coolifyDeploymentId?: string;
  status: string;
  triggeredById?: UUID;
  commitSha?: string;
  commitMessage?: string;
};

export type DeploymentWithEnvironment = Deployment & {
  environment: Environment & { site: Site };
};

// ============================================================
// Collaborators
// ============================================================

export type CollaboratorRole = "owner" | "admin" | "operator" | "viewer";

export type Collaborator = {
  id: UUID;
  organizationId: UUID;
  userId: UUID;
  role: CollaboratorRole;
  grantedById?: UUID;
  grantedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
};

export type CollaboratorCreateInput = {
  organizationId: UUID;
  userId: UUID;
  role: CollaboratorRole;
  grantedById?: UUID;
};

export type CollaboratorWithUser = Collaborator & {
  user: User;
};

export type SiteCollaborator = {
  id: UUID;
  siteId: UUID;
  userId: UUID;
  role: CollaboratorRole;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
};

// ============================================================
// API Tokens
// ============================================================

export type ApiToken = {
  id: UUID;
  userId: UUID;
  organizationId?: UUID;
  tokenHash: string;
  name?: string;
  lastUsedAt?: Date;
  expiresAt?: Date;
  createdAt: Date;
  revokedAt?: Date;
};

export type ApiTokenCreateInput = {
  userId: UUID;
  organizationId?: UUID;
  name?: string;
  expiresAt?: Date;
};

// ============================================================
// Audit Logs
// ============================================================

export type AuditLogAction =
  | "deploy_triggered"
  | "site_created"
  | "site_updated"
  | "site_deleted"
  | "collaborator_added"
  | "collaborator_removed"
  | "collaborator_role_changed"
  | "organization_created"
  | "organization_updated"
  | "api_token_created"
  | "api_token_revoked";

export type AuditLog = {
  id: UUID;
  organizationId: UUID;
  actorId?: UUID;
  action: AuditLogAction;
  resourceType?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
};

export type AuditLogCreateInput = {
  organizationId: UUID;
  actorId?: UUID;
  action: AuditLogAction;
  resourceType?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
};

// ============================================================
// Permissions and Authorization
// ============================================================

export type Permission =
  | "read"
  | "deploy"
  | "manage_collaborators"
  | "manage_organization"
  | "manage_site"
  | "manage_environments";

export type PermissionMatrix = {
  owner: Permission[];
  admin: Permission[];
  operator: Permission[];
  viewer: Permission[];
};

export const ROLE_PERMISSIONS: PermissionMatrix = {
  owner: [
    "read",
    "deploy",
    "manage_collaborators",
    "manage_organization",
    "manage_site",
    "manage_environments"
  ],
  admin: [
    "read",
    "deploy",
    "manage_collaborators",
    "manage_site",
    "manage_environments"
  ],
  operator: ["read", "deploy"],
  viewer: ["read"]
};

// ============================================================
// Helper Functions
// ============================================================

export function canUser(userRole: CollaboratorRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[userRole].includes(permission);
}

export function createUUID(value: string): UUID {
  return value as UUID;
}
