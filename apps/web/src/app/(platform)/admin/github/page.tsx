import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";
import { isPlatformAdminEmail } from "@/lib/permissions";
import { buildAppManifest } from "@/lib/github-app-manifest";
import { signInstallState } from "@/lib/github-install-state";
import { installStateSecret } from "@/lib/github-route-access";
import GithubAppSetup from "@/components/GithubAppSetup";

type Props = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

const RESULTS: Record<string, { tone: "ok" | "warn"; text: string }> = {
  created: { tone: "ok", text: "The Jongo GitHub App is ready. Clients can now connect GitHub from their settings." },
  exists: { tone: "warn", text: "A Jongo GitHub App already exists, so the new one wasn't saved. Delete the extra app on GitHub." },
  link_expired: { tone: "warn", text: "That link expired. Start again." },
  missing_code: { tone: "warn", text: "GitHub didn't send the app back. Start again." },
  failed: { tone: "warn", text: "GitHub created the app, but Jongo couldn't read its details. Start again, then delete the extra app on GitHub." },
  not_admin: { tone: "warn", text: "Only platform admins can create the GitHub App." }
};

/** Platform admins: create the one Jongo GitHub App (GitHub's manifest flow). */
export default async function GithubAdminPage({ searchParams }: Props) {
  const session = await auth();
  if (!(await isPlatformAdminEmail(session?.user?.email)) || !session?.user?.id) notFound();

  const params = (await searchParams) ?? {};
  const resultKey = Array.isArray(params.result) ? params.result[0] : params.result;
  const result = resultKey ? RESULTS[resultKey] : null;

  const db: any = await getDb();
  const app = db ? await db.githubAppConfig.findFirst({ orderBy: { createdAt: "asc" } }) : null;
  const installs = db && app ? await db.githubInstallation.groupBy({ by: ["status"], _count: { _all: true } }) : [];

  const h = await headers();
  const origin = process.env.PUBLIC_SITE_URL?.trim() || `${h.get("x-forwarded-proto") ?? "https"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  const secret = installStateSecret();
  const state = secret ? signInstallState({ orgId: "platform", userId: session.user.id }, secret) : "";

  return (
    <div className="page-stack">
      <article className="card">
        <h2 className="card-title">GitHub deploys</h2>
        <p className="card-muted mt-1 mb-0">
          One Jongo GitHub App lets every client connect their own GitHub and deploy private repos. It only reads code and repo details, and only for the repos each client picks.
        </p>
        {result ? (
          <p className={`mt-3 mb-0 px-3 py-2 rounded-lg text-[13px] border border-solid ${result.tone === "ok" ? "bg-healthy-bg border-healthy-border text-healthy-text" : "bg-warn-bg border-warn-border text-warn-text"}`}>
            {result.text}
          </p>
        ) : null}
        {app ? (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-[13.5px]">
            <div>
              <p className="m-0 text-muted text-[12px]">App</p>
              <a className="action-link font-semibold" href={app.htmlUrl} target="_blank" rel="noopener noreferrer">{app.name}</a>
            </div>
            <div>
              <p className="m-0 text-muted text-[12px]">Install link clients use</p>
              <span className="font-mono text-[12.5px] break-all">https://github.com/apps/{app.slug}</span>
            </div>
            <div>
              <p className="m-0 text-muted text-[12px]">Key on the hosting server</p>
              <span>{app.coolifyPrivateKeyUuid ? "In place" : "Not uploaded yet"}</span>
            </div>
            <div>
              <p className="m-0 text-muted text-[12px]">Connected clients</p>
              <span>
                {installs.length === 0
                  ? "None yet"
                  : installs.map((row: any) => `${row._count._all} ${row.status}`).join(" · ")}
              </span>
            </div>
            <div className="sm:col-span-2">
              <GithubAppSetup mode="resync" hasKey={Boolean(app.coolifyPrivateKeyUuid)} />
            </div>
          </div>
        ) : (
          <GithubAppSetup
            mode="create"
            state={state}
            manifest={JSON.stringify(buildAppManifest({ baseUrl: origin, name: "Jongo Deploys" }))}
            disabledReason={secret ? null : "NEXTAUTH_SECRET is not set, so the connect link can't be signed."}
          />
        )}
      </article>
    </div>
  );
}
