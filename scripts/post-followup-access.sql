select email
from "User"
where lower(email) like lower('%lot6six%')
order by email;

select count(*)::int as collaborator_rows
from "Collaborator"
where "deletedAt" is null;

select
  o.name,
  c.role,
  u.email
from "Collaborator" c
join "Organization" o on o.id = c."organizationId"
join "User" u on u.id = c."userId"
where c."deletedAt" is null
  and o."deletedAt" is null
order by o.name, u.email
limit 20;
