# Global Design System & Helper Contracts

## 1. Unified Permission Helper Contract (`permissions.ts`)
All UI components MUST check permissions using a standardized model rather than ad-hoc role checks:

```typescript
export interface UserPermissions {
  isPlatformAdmin: boolean;
  isAdmin: boolean;         // Org admin or Site admin
  isCollaborator: boolean;  // Basic collaborator
  
  // Feature Capabilities
  canManageTeam: boolean;      // Invite / edit / remove collaborators
  canManageBackups: boolean;   // Trigger / restore backups
  canManageStaging: boolean;   // Enable / push / sync staging
  canViewDiagnostics: boolean; // Raw UUIDs, telemetry logs, infrastructure errors
  canEditDomains: boolean;     // Add / edit primary & staging domains
}

export function getPermissions(callerRole: 'admin' | 'collaborator', isPlatformAdmin = false): UserPermissions {
  const isAdmin = callerRole === 'admin' || isPlatformAdmin;
  return {
    isPlatformAdmin,
    isAdmin,
    isCollaborator: !isAdmin,
    canManageTeam: isAdmin,
    canManageBackups: isAdmin,
    canManageStaging: isAdmin,
    canViewDiagnostics: isPlatformAdmin || isAdmin,
    canEditDomains: isAdmin,
  };
}