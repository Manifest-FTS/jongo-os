select count(*) as org_count from "Organization" where "deletedAt" is null;
select count(*) as site_count from "Site" where "deletedAt" is null;

select o.name
from "Organization" o
join "Collaborator" c on c."organizationId" = o.id
join "User" u on u.id = c."userId"
where lower(u.email) = lower('lot6six@manifestfts.com')
  and c."deletedAt" is null
  and o."deletedAt" is null
order by o.name;

select o.name as org_name, s.name as app_name
from "Site" s
join "Organization" o on o.id = s."organizationId"
where o."deletedAt" is null
  and s."deletedAt" is null
order by o.name, s.name;
