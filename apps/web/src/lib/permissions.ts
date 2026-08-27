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

/**
 * What a role may do, one capability per action.
 *
 * Deliberately NOT grouped into broad flags like "canManageBackups". That flag
 * covered taking a backup, restoring one over the live site, and downloading
 * every file and database credential the site has — three very different levels
 * of trust behind one boolean, and because it was true for everyone, a
 * collaborator could overwrite production. Each capability now names a single
 * action so widening one cannot silently widen the others.
 *
 * The rule applied throughout: a collaborator may do anything that is additive
 * or reversible, and nothing that destroys data, takes the site down, or hands
 * out credentials.
 */
export interface UserPermissions {
  isPlatformAdmin: boolean;
  isAdmin: boolean;
  isCollaborator: boolean;

  canManageTeam: boolean;

  /** Taking a backup only adds a restore point. */
  canCreateBackup: boolean;
  /** Editing the note on a backup changes nothing about the site. */
  canAnnotateBackup: boolean;
  /** DESTRUCTIVE — overwrites the live site's files and database. */
  canRestoreBackup: boolean;
  /** Hands over every file plus a database dump, including wp-config credentials. */
  canDownloadBackup: boolean;
  /** Changes how well the site is protected, and for how long. */
  canManageBackupSchedule: boolean;

  /** Issues credentials with read/write access to every file the site runs on. */
  canManageSftp: boolean;

  /** Writes to the staging copy only; production is untouched. */
  canSyncStaging: boolean;
  /** DESTRUCTIVE — replaces production with the staging copy. */
  canPromoteStaging: boolean;
  /** Creating or destroying the staging environment itself. */
  canManageStagingEnvironment: boolean;

  /** Non-destructive: caches regenerate on the next request. */
  canFlushCache: boolean;
  canEditDomains: boolean;

  /**
   * Privacy mode is split three ways because the two directions are not
   * equivalent. Turning it ON adds protection. Turning it OFF publishes a site
   * somebody deliberately hid — and unlike most reversible actions, you cannot
   * un-index a page a crawler already fetched.
   */
  canEnablePrivacyMode: boolean;
  canDisablePrivacyMode: boolean;
  /** Changing the username or regenerating the password. */
  canManagePrivacyCredentials: boolean;
  canViewDiagnostics: boolean;
  /** Removes the app, and optionally the running resource behind it. */
  canDeleteSite: boolean;
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

/**
 * The full admin check: the env-configured seed admin, OR anyone the seed
 * admin has granted platform-admin access to via PlatformAdmin. Async
 * because the grant list lives in the database; checkIsPlatformAdmin above
 * stays synchronous and seed-only for call sites that only need that one
 * fast, DB-free check (e.g. "may this caller manage the admin list itself").
 */
export async function isPlatformAdminEmail(userEmail?: string | null): Promise<boolean> {
  if (checkIsPlatformAdmin(userEmail)) return true;

  const normalized = normalizeEmail(userEmail);
  if (!normalized) return false;

  const db = await getDb();
  if (!db) return false;

  const grant = await db.platformAdmin.findFirst({
    where: { user: { email: { equals: normalized, mode: "insensitive" } } },
    select: { id: true }
  });
  return Boolean(grant);
}

/**
 * Platform admins for display, not for access control.
 *
 * They already see and manage every client without a Collaborator row on any
 * Organization -- that row grants membership a client can review and revoke,
 * and a platform admin's access is neither: it comes from the bootstrap email
 * check (or a PlatformAdmin grant) and isn't something a client team can
 * remove. Team lists should still disclose it honestly (a client asking
 * "who can see our stuff" deserves a real answer), just not as a synthetic
 * member row that looks removable when it is not.
 */
export async function getPlatformAdminContacts(): Promise<string[]> {
  const seed = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim();
  const contacts = seed ? [seed] : [];

  const db = await getDb();
  if (!db) return contacts;

  const grants = await db.platformAdmin.findMany({ select: { user: { select: { email: true } } } });
  const seenLower = new Set(contacts.map((email) => email.toLowerCase()));
  for (const grant of grants) {
    const email = grant.user?.email;
    if (email && !seenLower.has(email.toLowerCase())) {
      seenLower.add(email.toLowerCase());
      contacts.push(email);
    }
  }
  return contacts;
}


export function getPermissions(callerRole: unknown, isPlatformAdmin = false): UserPermissions {
  const role = normalizeRole(callerRole);
  const isAdmin = role === "admin" || isPlatformAdmin;

  return {
    isPlatformAdmin,
    isAdmin,
    isCollaborator: !isAdmin,

    canManageTeam: isAdmin,

    // Additive or reversible — open to collaborators.
    canCreateBackup: true,
    canAnnotateBackup: true,
    // Flushing a cache is non-destructive and is the first thing anyone
    // debugging a stale page needs to try; making it admin-only meant whoever
    // could see the problem had to find someone else to press the button.
    canFlushCache: true,
    // Overwrites the staging copy, never production.
    canSyncStaging: true,
    // Both roles, per TSK-00829: making a site private protects it, and the
    // person who notices it is public should not have to go find an admin.
    canEnablePrivacyMode: true,

    // Destroys data, takes the site down, or hands out credentials — admin only.
    canRestoreBackup: isAdmin,
    canDownloadBackup: isAdmin,
    canManageBackupSchedule: isAdmin,
    canManageSftp: isAdmin,
    // Exposing the site, and rotating a credential already shared with a
    // client, are both admin-only. A collaborator may raise protection, never
    // lower it.
    canDisablePrivacyMode: isAdmin,
    canManagePrivacyCredentials: isAdmin,
    canPromoteStaging: isAdmin,
    canManageStagingEnvironment: isAdmin,
    canEditDomains: isAdmin,
    canViewDiagnostics: isAdmin,
    canDeleteSite: isAdmin
  };
}

export async function resolveSitePermissionSnapshot(
  input: ResolveSitePermissionInput
): Promise<SitePermissionSnapshot> {
  const userId = input.viewer?.userId?.trim();
  const isPlatformAdmin = await isPlatformAdminEmail(input.viewer?.email);

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
        // Use a narrow select so legacy databases without newer Site scalar
        // columns can still resolve role-based permissions safely.
        select: {
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
    // The telemetry API has always required an admin; this said otherwise, so a
    // collaborator was shown controls that answered 403.
    canManageTelemetry: permissions.isAdmin,
    canManageDomains: Boolean(userId && permissions.canEditDomains)
  };
}