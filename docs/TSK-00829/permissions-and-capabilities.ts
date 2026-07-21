// Capabilities Contract (example only, modify per existing capabilities/documented processes)

export interface AppCapabilities {
  hasWordPress: boolean;
  hasStaging: boolean;
  hasDatabase: boolean;
  hasCustomDomains: boolean;
}

export function getAppCapabilities(appType: string): AppCapabilities {
  return {
    hasWordPress: appType === 'wordpress',
    hasStaging: true,
    hasDatabase: appType === 'wordpress' || appType === 'postgres' || appType === 'mysql',
    hasCustomDomains: true,
  };
}

// Permisssions Contract (example only, modify per existing capabilities/documented processes)
export type CanonicalRole = 'admin' | 'collaborator';

export interface UserPermissions {
  // Role Types
  isPlatformAdmin: boolean;
  isAdmin: boolean;
  isCollaborator: boolean;

  // Feature & UI Gating Flags
  canManageTeam: boolean;        // Invite, edit, or remove collaborators
  canManageBackups: boolean;     // Trigger, delete, or restore backups
  canManageStaging: boolean;     // Provision, sync, or promote staging
  canEditDomains: boolean;       // Add, edit, or delete domain mappings
  canTogglePrivacyMode: boolean; // Enable/disable basic auth on public site
  canViewDiagnostics: boolean;  // View raw engine noise, UUIDs, telemetry, system logs
}

/**
 * Normalizes legacy role strings ('owner', 'operator', 'member', 'viewer')
 * into the canonical Jongo OS roles ('admin' | 'collaborator').
 */
export function normalizeRole(role?: string | null): CanonicalRole {
  if (!role) return 'collaborator';

  const normalized = role.toLowerCase().trim();
  if (['admin', 'owner', 'operator'].includes(normalized)) {
    return 'admin';
  }
  return 'collaborator';
}

/**
 * Helper to check if a user is a global Platform Admin via BOOTSTRAP_ADMIN_EMAIL.
 */
export function checkIsPlatformAdmin(
  userEmail?: string | null,
  bootstrapEmail: string | null = process.env.BOOTSTRAP_ADMIN_EMAIL || null
): boolean {
  if (!userEmail || !bootstrapEmail) return false;
  return userEmail.toLowerCase().trim() === bootstrapEmail.toLowerCase().trim();
}

/**
 * Primary permission contract for Jongo OS UI & API routes.
 * 
 * @param callerRole Raw or normalized role string ('admin' | 'collaborator' | legacy)
 * @param isPlatformAdmin Whether the user matches the bootstrap admin override
 */
export function getPermissions(
  callerRole: string | CanonicalRole,
  isPlatformAdmin = false
): UserPermissions {
  const role = normalizeRole(callerRole);
  const isAdmin = role === 'admin' || isPlatformAdmin;

  return {
    isPlatformAdmin,
    isAdmin,
    isCollaborator: !isAdmin,

    // Admin-gated operations
    canManageTeam: isAdmin,
    canManageBackups: isAdmin,
    canManageStaging: isAdmin,
    canEditDomains: isAdmin,

    // Shared operational capabilities (Admins + Collaborators)
    canTogglePrivacyMode: true,

    // Engine Noise & Infrastructure Diagnostics (Hidden from pure collaborators)
    canViewDiagnostics: isAdmin,
  };
}