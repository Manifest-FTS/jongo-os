import { redirect } from "next/navigation";

type Params = { params: Promise<{ siteId: string }> };

export default async function AppPluginsPage({ params }: Params) {
	const { siteId } = await params;
	redirect(`/apps/${siteId}/integrations?focus=plugins`);
}
