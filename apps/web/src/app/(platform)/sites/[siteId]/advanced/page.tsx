import { redirect } from "next/navigation";

type Params = { params: Promise<{ siteId: string }> };

export default async function AdvancedPage({ params }: Params) {
  const { siteId } = await params;
  redirect(`/apps/${siteId}/settings#runtime-diagnostics`);
}
