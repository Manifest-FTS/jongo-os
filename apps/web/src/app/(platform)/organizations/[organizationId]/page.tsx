import { redirect } from "next/navigation";

type Params = { params: Promise<{ organizationId: string }> };

export default async function OrganizationDetailPage({ params }: Params) {
  const { organizationId } = await params;
  redirect(`/clients/${organizationId}`);
}
