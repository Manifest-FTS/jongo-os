select
  s.id,
  s.slug,
  s.name,
  s."coolifyServiceId",
  s."coolifyServiceUuid",
  s."coolifyProjectId",
  s."organizationId",
  o.name as organization_name,
  o.slug as organization_slug,
  o."coolifyProjectId" as org_legacy_project_id,
  o."coolifyProjectName" as org_legacy_project_name,
  l."coolifyProjectId" as link_project_id,
  l."coolifyProjectName" as link_project_name,
  l."isPrimary",
  l."deletedAt" as link_deleted_at
from "Site" s
left join "Organization" o on o.id = s."organizationId"
left join "OrganizationCoolifyProjectLink" l
  on l."organizationId" = o.id
 and l."deletedAt" is null
where s."deletedAt" is null
  and s.slug = 'millenion-fitness'
order by l."isPrimary" desc nulls last, l."createdAt" asc nulls last;
