import { redirect } from "next/navigation";
import { auth } from "@/lib/auth.config";
import BillingPanel from "@/components/BillingPanel";

/** Your plan: what it is, whether it's paid, when it renews, and managing it. */
export default async function BillingPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/auth/login?callbackUrl=/billing");
  const query = (await searchParams) ?? {};
  return (
    <div className="page-stack" style={{ maxWidth: "48rem" }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Billing</h1>
          <p className="page-subtitle">Your plan covers hosting for every client you own.</p>
        </div>
      </div>
      <BillingPanel justPaid={query.checkout === "success"} />
    </div>
  );
}
