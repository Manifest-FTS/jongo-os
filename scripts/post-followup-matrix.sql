select count(*) as mapped_site_rows
from "Site"
where "deletedAt" is null;

select count(*) as active_org_project_links
from "OrganizationCoolifyProjectLink"
where "deletedAt" is null;

select
  o.name as org_name,
  l."coolifyProjectId" as project_id,
  l."coolifyProjectName" as project_name,
  l."isPrimary"
from "OrganizationCoolifyProjectLink" l
join "Organization" o on o.id = l."organizationId"
where l."deletedAt" is null
  and o."deletedAt" is null
order by o.name, l."isPrimary" desc;

select
  o.name,
  count(s.id)::int as mapped_apps
from "Organization" o
left join "Site" s
  on s."organizationId" = o.id
 and s."deletedAt" is null
where o."deletedAt" is null
group by o.name
order by o.name;

select
  u.email,
  count(distinct o.id)::int as visible_orgs,
  count(distinct s.id)::int as visible_sites
from "User" u
left join "Organization" o
  on o."deletedAt" is null
 and (
   o."ownerId" = u.id
   or exists (
     select 1
     from "Collaborator" c
     where c."organizationId" = o.id
       and c."userId" = u.id
       and c."deletedAt" is null
   )
 )
left join "Site" s
  on s."organizationId" = o.id
 and s."deletedAt" is null
where lower(u.email) in (lower('devkev@manifestfts.com'), lower('lot6six@manifestfts.com'))
group by u.email
order by u.email;
