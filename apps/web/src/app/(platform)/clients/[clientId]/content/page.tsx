import React from "react";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth.config";
import { resolveOrganizationCmsCapabilities } from "@/lib/cms/entitlements";
import { cmsSchemaRegistry } from "@/lib/cms/schemas";
import { isUuid } from "@/lib/site-identity";
import CmsFormBuilder from "@/components/cms/CmsFormBuilder";

export const dynamic = "force-dynamic";

/** Organization-scoped descriptors only, not dataset/content authorization. */
export default async function ClientContentPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  if (!isUuid(clientId)) notFound();
  const session = await auth();
  if (!session?.user?.id) notFound();
  if (process.env.JONGO_CMS_ENABLED !== "true") {
    return <section className="card"><h2>CMS schema preview unavailable</h2><p>The CMS feature is disabled.</p><p>Schema preview only. Nothing is saved or published.</p></section>;
  }
  const capabilities = await resolveOrganizationCmsCapabilities(session.user.id, clientId);
  if (capabilities.scope !== "organization" || capabilities.organizationId !== clientId || !capabilities.features["cms.read"]) notFound();
  return <section className="page-stack">
    <header><h2>Content schema preview</h2><p>Explore the five registered schemas. No stored content, dataset, or publishing workflow is connected.</p></header>
    <CmsFormBuilder schemas={cmsSchemaRegistry.descriptors} canAuthor={capabilities.features["cms.author"]} />
  </section>;
}