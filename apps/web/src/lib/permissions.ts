import { getDb } from "@/lib/db";
import type { SiteWorkspaceRecord, ViewerContext } from "@/lib/repositories";
import { isClientAdmin } from "@/lib/repositories";
import { isAdminRole, normalizeRole } from "@/lib/roles";

export interface AppCapabilities {
  hasWordPress: boolean;
  hasStaging: boolean;
  hasDatabase: boolean;
  hasCustomDomains: boolean;
}

export type CanonicalRole = "admin" | "collaborator";

export interface UserPermissions {
  isPlatformAdmin: boolean;
  isAdmin: boolean;
  isCollaborator: boolean;
  canManageTeam: boolean;
  canManageBackups: boolean;
  canManageStaging: boolean;
  canEditDomains: boolean;
  canTogglePrivacyMode: boolean;
  canViewDiagnostics: boolean;
}

export interface SitePermissionSnapshot extends UserPermissions {
  role: CanonicalRole;
  canViewInternalMetadata: boolean;
  canManageTelemetry: boolean;
  canManageDomains: boolean;
}

type ResolveSitePermissionInput = {
  siteId: string;
  workspace: Pick<
    SiteWorkspaceRecord,
    "id" | "slug" | "name" | "organizationId" | "coolifyServiceUuid" | "coolifyProjectId"
  >;
  viewer?: ViewerContext;
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeEmail(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function dedupeNonEmpty(values: Array<string | undefined>): string[] {
  return values
    .map((value) => value?.trim() || "")
    .filter((value, index, arr) => value.length > 0 && arr.indexOf(value) === index);
}

function buildIdentityMatchers(values: string[]) {
  return values.flatMap((value): Array<Record<string, string>> =>
    isUuid(value)
      ? [
          { id: value },
          { slug: value },
          { coolifyServiceUuid: value },
          { coolifyServiceId: value },
          { coolifyProjectId: value }
        ]
      : [
          { slug: value },
          { coolifyServiceUuid: value },
          { coolifyServiceId: value },
          { coolifyProjectId: value },
          { name: value }
        ]
  );
}

export function getAppCapabilities(appType: string): AppCapabilities {
  const normalizedType = appType.trim().toLowerCase();
  return {
    hasWordPress: normalizedType === "wordpress",
    hasStaging: true,
    hasDatabase: ["wordpress", "postgres", "mysql", "mariadb"].includes(normalizedType),
    hasCustomDomains: true
  };
}

export function checkIsPlatformAdmin(
  userEmail?: string | null,
  bootstrapEmail: string | null = process.env.BOOTSTRAP_ADMIN_EMAIL || null
): boolean {
  const viewer = normalizeEmail(userEmail);
  const configured = normalizeEmail(bootstrapEmail);
  return Boolean(viewer && configured && viewer === configured);
}

export function getPermissions(callerRole: unknown, isPlatformAdmin = false): UserPermissions {
  const role = normalizeRole(callerRole);
  const isAdmin = role === "admin" || isPlatformAdmin;

  return {
    isPlatformAdmin,
    isAdmin,
    isCollaborator: !isAdmin,
    canManageTeam: isAdmin,
    canManageBackups: isAdmin,
    canManageStaging: isAdmin,
    canEditDomains: isAdmin,
    canTogglePrivacyMode: true,
    canViewDiagnostics: isAdmin
  };
}

export async function resolveSitePermissionSnapshot(
  input: ResolveSitePermissionInput
): Promise<SitePermissionSnapshot> {
  const userId = input.viewer?.userId?.trim();
  const isPlatformAdmin = checkIsPlatformAdmin(input.viewer?.email);

  const canViewInternalMetadata = Boolean(
    userId && input.workspace.organizationId && (await isClientAdmin(input.workspace.organizationId, userId))
  );

  let role: CanonicalRole = canViewInternalMetadata || isPlatformAdmin ? "admin" : "collaborator";

  if (userId) {
    const db = await getDb();
    if (db) {
      const identifiers = dedupeNonEmpty([
        input.siteId,
        input.workspace.id,
        input.workspace.slug,
        input.workspace.coolifyServiceUuid,
        input.workspace.coolifyProjectId,
        input.workspace.name
      ]);

      const site = await db.site.findFirst({
        where: {
          AND: [
            {
              deletedAt: null,
              OR: buildIdentityMatchers(identifiers) as any
            },
            ...(input.workspace.organizationId ? [{ organizationId: input.workspace.organizationId }] : []),
            ...(isPlatformAdmin
              ? []
              : [
                  {
                    OR: [
                      {
                        organization: {
                          deletedAt: null,
                          OR: [
                            { ownerId: userId },
                            { collaborators: { some: { userId, deletedAt: null } } }
                          ]
                        }
                      },
                      { collaborators: { some: { userId, deletedAt: null } } }
                    ]
                  }
                ])
          ]
        },
        include: {
          organization: {
            select: {
              ownerId: true,
              collaborators: {
                where: { userId, deletedAt: null },
                select: { role: true }
              }
            }
          },
          collaborators: {
            where: { userId, deletedAt: null },
            select: { role: true }
          }
        }
      });

      const ownerAdmin = site?.organization?.ownerId === userId;
      const orgCollaboratorAdmin = isAdminRole(site?.organization?.collaborators?.[0]?.role);
      const siteAdmin = isAdminRole(site?.collaborators?.[0]?.role);
      if (ownerAdmin || orgCollaboratorAdmin || siteAdmin) {
        role = "admin";
      }
    }
  }

  const permissions = getPermissions(role, isPlatformAdmin);

  return {
    ...permissions,
    role,
    canViewInternalMetadata,
    canManageTelemetry: permissions.isAdmin || canViewInternalMetadata,
    canManageDomains: Boolean(userId && permissions.canEditDomains)
  };
}