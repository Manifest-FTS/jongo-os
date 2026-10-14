import { notFound } from "next/navigation";
import { auth } from "@/lib/auth.config";
import { getClientWorkspace, isClientAdmin } from "@/lib/repositories";
import { canUseGithubForOrg } from "@/lib/github-route-access";
import { listGitSources } from "@/lib/github-installations";
import { clientAppName } from "@/lib/github-app-manifest";
import GitSourcesManager from "@/components/GitSourcesManager";

type Params = { params: Promise<{ clientId: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> };

/** Git sources for one client — Coolify's Sources page, for the client's team. */
export default async function ClientSourcesPage({ params, searchParams }: Params) {
  const { clientId } = await params;
  const query = (await searchParams) ?? {};
  const session = await auth();
  const client = await getClientWorkspace(clientId, { userId: session?.user?.id, email: session?.user?.email });
  if (!client?.dbId || !session?.user?.id) notFound();
  const allowed = await canUseGithubForOrg(client.dbId, session.user.id, session.user.email);
  if (!allowed) notFound();
  const [sources, isAdmin] = await Promise.all([listGitSources(client.dbId), isClientAdmin(client.dbId, session.user.id)]);
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? null;
  return (
    <GitSourcesManager
      organizationId={client.dbId}
      initialSources={sources}
      canDelete={isAdmin}
      suggestedName={clientAppName(client.name, client.dbId)}
      returnStatus={first(query.github)}
      focusSourceId={first(query.source)}
    />
  );
}
