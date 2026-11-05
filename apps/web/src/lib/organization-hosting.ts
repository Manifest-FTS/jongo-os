/**
 * Every client gets its own hosting project, created automatically.
 *
 * Called when a client is created, and again before an app is created, so a
 * client whose project could not be made at creation time (hosting briefly
 * down), or one that existed before this, is fixed the first time it is used.
 *
 * Exactly one project per client, even under retries and simultaneous calls:
 *  - a Postgres advisory lock serialises callers for the same client;
 *  - each project Jongo creates carries a marker with the client's id in its
 *    description, so if a previous attempt created the project but failed to
 *    save it, the next attempt finds and adopts it instead of making another.
 *
 * Only projects carrying this client's marker are ever adopted. A project is
 * never claimed by name: linking someone else's existing project stays a
 * platform-admin action.
 *
 * Uses Coolify's documented project API: GET/POST /api/v1/projects,
 * PATCH/DELETE /api/v1/projects/{uuid}. Coolify creates the "production"
 * environment with every new project, which is where apps are created.
 */

export type HostingProjectResult =
  | { ok: true; projectUuid: string; created: boolean }
  | { ok: false; reason: string; message: string; /** For admins: what hosting said. */ detail?: string };

/** What a refusal from hosting most likely means, in words an admin can act on. */
export function explainHostingRefusal(status: number | undefined): string {
  if (status === 401 || status === 403) {
    return `Hosting refused (HTTP ${status}). The hosting API token Jongo uses can't create projects: give it write access in the hosting dashboard's API token settings, then update COOLIFY_API_TOKEN.`;
  }
  if (status === 429) return "Hosting is rate-limiting requests (HTTP 429). Try again in a minute.";
  if (typeof status === "number" && status >= 500) return `Hosting had an internal error (HTTP ${status}). Check the hosting server's own logs.`;
  if (typeof status === "number" && status > 0) return `Hosting refused the request (HTTP ${status}).`;
  return "Hosting didn't answer (timeout or network). Check that Jongo can reach Coolify's API.";
}

type Deps = {
  db: any;
  listProjects: () => Promise<unknown>;
  createProject: (body: { name: string; description: string }) => Promise<{ ok: boolean; status?: number; body?: unknown }>;
};

const MARKER_PREFIX = "jongo-org:";

export function hostingProjectMarker(organizationId: string): string {
  return `${MARKER_PREFIX}${organizationId}`;
}

export function hostingProjectDescription(organizationName: string, organizationId: string): string {
  return `Managed by Jongo for ${organizationName}. Do not remove this line: ${hostingProjectMarker(organizationId)}`;
}

/** Was this project created by Jongo for this client? */
export function isJongoProjectFor(description: unknown, organizationId: string): boolean {
  if (typeof description !== "string") return false;
  // Exact token match, so one client's id can never match inside another's.
  return description.split(/\s+/).includes(hostingProjectMarker(organizationId));
}

/** Coolify shows this in its dashboard; keep it readable and bounded. */
export function hostingProjectName(organizationName: string): string {
  const name = organizationName.replace(/\s+/g, " ").trim().slice(0, 100);
  return name || "Jongo client";
}

async function defaultDeps(): Promise<Deps> {
  const [{ db }, core] = await Promise.all([import("@/lib/db"), import("@/lib/coolify-core")]);
  return {
    db,
    listProjects: () => core.coolifyFetch("/api/v1/projects"),
    createProject: (body) => core.coolifyMutateWithResponse("/api/v1/projects", "POST", body)
  };
}

function projectRows(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  const data = (payload as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
}

const UNAVAILABLE: HostingProjectResult = {
  ok: false,
  reason: "hosting_unavailable",
  message: "Hosting isn't reachable right now, so this client's hosting space couldn't be set up. Try again in a few minutes."
};

async function saveProject(db: any, organizationId: string, projectUuid: string, projectName: string) {
  await db.organization.update({
    where: { id: organizationId },
    data: { coolifyProjectId: projectUuid, coolifyProjectName: projectName }
  });
  await db.$executeRaw`
    insert into "OrganizationCoolifyProjectLink" (
      id, "organizationId", "coolifyProjectId", "coolifyProjectName", "isPrimary", "createdAt", "updatedAt"
    ) values (
      gen_random_uuid(), ${organizationId}::uuid, ${projectUuid}, ${projectName}, true, now(), now()
    )
    on conflict do nothing
  `;
}

/**
 * Make sure this client has a hosting project; create one if not.
 * Safe to call any number of times.
 */
export async function ensureOrganizationHostingProject(
  organizationId: string,
  injected?: Partial<Deps>
): Promise<HostingProjectResult> {
  const { reportStep } = await import("@/lib/progress");
  reportStep("hosting", "Preparing the client's hosting space", "active");
  const result = await ensureProjectInner(organizationId, injected);
  reportStep("hosting", "Preparing the client's hosting space", result.ok ? "done" : "failed");
  return result;
}

async function ensureProjectInner(organizationId: string, injected?: Partial<Deps>): Promise<HostingProjectResult> {
  const deps = { ...(await defaultDeps()), ...injected } as Deps;
  if (!injected?.listProjects && (!process.env.COOLIFY_API_BASE_URL || !process.env.COOLIFY_API_TOKEN)) {
    return { ok: false, reason: "credentials_missing", message: "Hosting isn't connected yet, so apps can't be created." };
  }

  try {
    return await deps.db.$transaction(
      async (tx: any) => {
        // Held until the transaction ends: one caller per client at a time.
        await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${`org-hosting:${organizationId}`}, 0))`;

        const org = await tx.organization.findUnique({
          where: { id: organizationId },
          select: { id: true, name: true, coolifyProjectId: true, deletedAt: true }
        });
        if (!org || org.deletedAt) {
          return { ok: false, reason: "not_found", message: "This client no longer exists." } as HostingProjectResult;
        }
        if (org.coolifyProjectId?.trim()) {
          return { ok: true, projectUuid: org.coolifyProjectId.trim(), created: false } as HostingProjectResult;
        }

        // A previous attempt may have created it and then failed to save it.
        let existing: Record<string, unknown> | undefined;
        try {
          existing = projectRows(await deps.listProjects()).find((project) =>
            isJongoProjectFor(project.description, organizationId)
          );
        } catch (error) {
          const status = (error as { status?: number })?.status;
          console.error("[hosting] could not list projects", { organizationId, status, message: (error as Error)?.message });
          return { ...UNAVAILABLE, detail: explainHostingRefusal(status) } as HostingProjectResult;
        }
        if (existing && typeof existing.uuid === "string" && existing.uuid) {
          const name = typeof existing.name === "string" ? existing.name : hostingProjectName(org.name);
          await saveProject(tx, organizationId, existing.uuid, name);
          return { ok: true, projectUuid: existing.uuid, created: false } as HostingProjectResult;
        }

        const name = hostingProjectName(org.name);
        const created = await deps.createProject({ name, description: hostingProjectDescription(org.name, organizationId) });
        const uuid = (created.body as { uuid?: unknown } | undefined)?.uuid;
        if (!created.ok || typeof uuid !== "string" || !uuid) {
          console.error("[hosting] project create failed", { organizationId, status: created.status });
          // If it was created but the answer was lost, the marker lets the next
          // attempt adopt it rather than create a second one.
          return { ...UNAVAILABLE, detail: explainHostingRefusal(created.status) } as HostingProjectResult;
        }
        await saveProject(tx, organizationId, uuid, name);
        console.info("[hosting] created project for client", { organizationId, projectUuid: uuid });
        return { ok: true, projectUuid: uuid, created: true } as HostingProjectResult;
      },
      { timeout: 30_000, maxWait: 10_000 }
    );
  } catch (error) {
    // Includes a project id already linked to another client (unique column).
    const message = (error as Error)?.message ?? "";
    console.error("[hosting] ensure project failed", { organizationId, message });
    return {
      ...UNAVAILABLE,
      detail: /unique constraint/i.test(message)
        ? "The hosting project is already linked to another client in Jongo."
        : "Jongo's database couldn't save the hosting project. Check the app's logs for [hosting]."
    } as HostingProjectResult;
  }
}

/** Keep the hosting project's name in step with the client's, for projects Jongo created. */
export async function renameOrganizationHostingProject(organizationId: string, newName: string): Promise<void> {
  try {
    const [{ db }, core] = await Promise.all([import("@/lib/db"), import("@/lib/coolify-core")]);
    const org = await db.organization.findUnique({ where: { id: organizationId }, select: { coolifyProjectId: true } });
    const uuid = org?.coolifyProjectId?.trim();
    if (!uuid) return;
    const project = (await core.coolifyFetch(`/api/v1/projects/${encodeURIComponent(uuid)}`)) as Record<string, unknown> | null;
    if (!isJongoProjectFor(project?.description, organizationId)) return; // an admin-linked project keeps its name
    const name = hostingProjectName(newName);
    const result = await core.coolifyMutateWithResponse(`/api/v1/projects/${encodeURIComponent(uuid)}`, "PATCH", {
      name,
      description: hostingProjectDescription(newName, organizationId)
    });
    if (result.ok) {
      await db.organization.update({ where: { id: organizationId }, data: { coolifyProjectName: name } });
    }
  } catch (error) {
    console.error("[hosting] rename project failed", { organizationId, message: (error as Error)?.message });
  }
}

/**
 * Remove the hosting project of a deleted client, only if Jongo created it.
 * Coolify itself refuses to delete a project that still has resources.
 */
export async function removeOrganizationHostingProject(organizationId: string, projectUuid: string | null): Promise<void> {
  const uuid = projectUuid?.trim();
  if (!uuid) return;
  try {
    const core = await import("@/lib/coolify-core");
    const project = (await core.coolifyFetch(`/api/v1/projects/${encodeURIComponent(uuid)}`)) as Record<string, unknown> | null;
    if (!isJongoProjectFor(project?.description, organizationId)) return;
    const result = await core.coolifyMutateWithResponse(`/api/v1/projects/${encodeURIComponent(uuid)}`, "DELETE");
    if (!result.ok) console.warn("[hosting] project not removed", { organizationId, status: result.status });
  } catch (error) {
    console.error("[hosting] remove project failed", { organizationId, message: (error as Error)?.message });
  }
}
