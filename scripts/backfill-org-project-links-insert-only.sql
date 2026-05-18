insert into "OrganizationCoolifyProjectLink" (
  id,
  "organizationId",
  "coolifyProjectId",
  "coolifyProjectName",
  "isPrimary",
  "deletedAt",
  "createdAt",
  "updatedAt"
)
select
  gen_random_uuid(),
  o.id,
  o."coolifyProjectId",
  o."coolifyProjectName",
  true,
  null,
  now(),
  now()
from "Organization" o
where o."deletedAt" is null
  and o."coolifyProjectId" is not null
  and not exists (
    select 1
    from "OrganizationCoolifyProjectLink" l
    where l."organizationId" = o.id
      and l."coolifyProjectId" = o."coolifyProjectId"
  );
