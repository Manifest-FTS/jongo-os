import { notFound } from "next/navigation";
import { OidcErrorCard } from "@/components/oidc/OidcCards";
import { isOidcEnabled } from "@/lib/oidc/config";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function OidcErrorPage({ searchParams }: Props) {
  if (!isOidcEnabled()) notFound();
  const params = await searchParams;
  // Only a known code selects the copy; anything else gets the generic message, and the value is never rendered.
  const code = typeof params.e === "string" ? params.e : "unavailable";
  return <OidcErrorCard code={code} />;
}
