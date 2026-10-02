import Link from "next/link";
import { getDomainViewer } from "@/lib/domain-access";
import { getManageableOrganizations } from "@/lib/domain-orders";
import { isRegistrarConfigured } from "@/lib/registrar";
import DomainOrderForm from "@/components/domains/DomainOrderForm";

export const dynamic = "force-dynamic";

type Params = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export default async function NewDomainPage({ searchParams }: Params) {
  const sp = (await searchParams) ?? {};
  const viewer = await getDomainViewer();
  const organizations = viewer ? await getManageableOrganizations(viewer.userId, viewer.isPlatformAdmin) : [];

  return (
    <div className="page-stack max-w-[760px]">
      <div className="page-head">
        <div>
          <h1 className="page-title">Register or transfer a domain</h1>
          <p className="page-subtitle">You pay first; we place the order with the registrar right after, and set up DNS.</p>
        </div>
        <div className="page-head-actions">
          <Link href="/my-domains" className="btn btn-secondary">
            Back to domains
          </Link>
        </div>
      </div>

      {first(sp.checkout) === "cancelled" ? (
        <p className="m-0 px-3 py-2 rounded-lg border border-solid border-warn-border bg-warn-bg text-warn-text text-[0.88rem]">
          Checkout was cancelled. Nothing was charged and nothing was ordered.
        </p>
      ) : null}

      {!isRegistrarConfigured() ? (
        <article className="card">
          <p className="card-muted m-0">Domain ordering is not connected yet.</p>
        </article>
      ) : organizations.length === 0 ? (
        <article className="card">
          <p className="card-muted m-0">Only a client&apos;s admins can buy domains. Ask an admin of your client account.</p>
        </article>
      ) : (
        <DomainOrderForm
          organizations={organizations}
          initialDomain={first(sp.domain)}
          initialOperation={first(sp.op) === "transfer" ? "transfer" : "register"}
          defaultEmail={viewer?.email ?? ""}
          showWholesale={Boolean(viewer?.isPlatformAdmin)}
        />
      )}
    </div>
  );
}
