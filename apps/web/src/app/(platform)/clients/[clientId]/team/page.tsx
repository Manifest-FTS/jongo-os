import { redirect } from "next/navigation";

type Params = { params: Promise<{ clientId: string }> };

export default async function ClientTeamPage({ params }: Params) {
  const { clientId } = await params;
  redirect(`/clients/${clientId}`);
}
