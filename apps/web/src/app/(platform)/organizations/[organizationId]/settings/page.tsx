import { redirect } from "next/navigation";

type Params = { params: Promise<{ organizationId: string }> };

export default async function ClientSettingsPage({ params }: Params) {
  const { organizationId } = await params;
  redirect(`/clients/${organizationId}/settings`);
}
