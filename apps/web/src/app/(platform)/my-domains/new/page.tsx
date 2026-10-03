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

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="max-w-[560px] px-7 py-8 bg-white border border-solid border-border rounded-2xl shadow-card-sm">
      <h2 className="m-0 text-[17px] font-bold text-ink">{title}</h2>
      <p className="mt-1.5 mb-0 text-[14px] text-muted">{body}</p>
    </div>
  );
}

export default async function NewDomainPage({ searchParams }: Params) {
  const sp = (await searchParams) ?? {};
  const viewer = await getDomainViewer();
  const organizations = viewer ? await getManageableOrganizations(viewer.userId, viewer.isPlatformAdmin) : [];

  return (
    <div className="flex flex-col gap-6 max-w-[1120px]">
      <div>
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[13px] text-muted">
          <Link href="/my-domains" className="text-muted no-underline hover:text-ink">
            Domains
          </Link>
          <span aria-hidden>/</span>
          <span className="text-ink font-medium">New domain</span>
        </nav>
        <h1 className="page-title mt-2 mb-0">Get a domain</h1>
        <p className="mt-1.5 mb-0 text-[15px] text-muted max-w-[620px]">
          Register a new name or move one you already own. We handle the registrar, DNS and SSL; you pay once, securely.
        </p>
      </div>

      {first(sp.checkout) === "cancelled" ? (
        <p className="m-0 px-4 py-3 rounded-xl border border-solid border-warn-border bg-warn-bg text-warn-text text-[14px]">
          Checkout was cancelled. Nothing was charged and nothing was ordered.
        </p>
      ) : null}

      {!isRegistrarConfigured() ? (
        <EmptyState title="Domain ordering isn't connected yet" body="Ask your Jongo administrator to finish setting up domain registration." />
      ) : organizations.length === 0 ? (
        <EmptyState
          title="Only a client's admins can buy domains"
          body="Ask an admin on your client account to order the domain, or to make you an admin."
        />
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
