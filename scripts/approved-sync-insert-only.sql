-- Insert-only sync for approved mappings only.
-- Guardrails:
-- - No overwrite (updates are not used)
-- - No delete
-- - No ownership guessing

WITH approved_orgs(name, slug, project_id, project_name) AS (
  VALUES
    ('Manifest FTS', 'client-manifest-fts', 'ip1hwipx8sn24rd0dni67lb0', 'Manifest FTS'),
    ('Community Catalyst', 'client-community-catalyst', 'kan91vl6yh1h3uoqeboy607f', 'Community Catalyst'),
    ('JoyFeed', 'client-joyfeed', 'cplzvcszywes0ayod4jk4hme', 'JoyFeed'),
    ('Millenion Fitness', 'client-millenion-fitness', 'sndclvrx7rwe3zii9sm1fdt2', 'Millenion Fitness'),
    ('Daniel Kane', 'client-daniel-kane', 'ank4te9xzy8nz96ivyot1aoj', 'Daniel Kane'),
    ('Emile De Meyer', 'client-emile-de-meyer', 'ubw2fq966nic1bm0uwhq2bv5', 'Emile De Meyer')
),
owner_user AS (
  SELECT id
  FROM "User"
  WHERE lower(email) = lower('devkev@manifestfts.com')
  LIMIT 1
),
inserted_orgs AS (
  INSERT INTO "Organization" (
    id, slug, name, description, "ownerId", "coolifyProjectId", "coolifyProjectName", "createdAt", "updatedAt"
  )
  SELECT
    gen_random_uuid(),
    ao.slug,
    ao.name,
    'Imported from approved Coolify ownership mapping',
    ou.id,
    ao.project_id,
    ao.project_name,
    now(),
    now()
  FROM approved_orgs ao
  CROSS JOIN owner_user ou
  WHERE NOT EXISTS (
    SELECT 1
    FROM "Organization" o
    WHERE lower(o.name) = lower(ao.name)
      AND o."deletedAt" IS NULL
  )
    AND NOT EXISTS (
      SELECT 1
      FROM "Organization" o
      WHERE o.slug = ao.slug
    )
  RETURNING id, name
),
org_lookup AS (
  SELECT o.id, o.name, ao.project_id, ao.project_name
  FROM approved_orgs ao
  JOIN "Organization" o
    ON lower(o.name) = lower(ao.name)
   AND o."deletedAt" IS NULL
),
inserted_links AS (
  INSERT INTO "OrganizationCoolifyProjectLink" (
    id, "organizationId", "coolifyProjectId", "coolifyProjectName", "isPrimary", "createdAt", "updatedAt"
  )
  SELECT
    gen_random_uuid(),
    ol.id,
    ol.project_id,
    ol.project_name,
    true,
    now(),
    now()
  FROM org_lookup ol
  WHERE NOT EXISTS (
    SELECT 1
    FROM "OrganizationCoolifyProjectLink" l
    WHERE l."organizationId" = ol.id
      AND l."coolifyProjectId" = ol.project_id
  )
  RETURNING id
)
SELECT
  (SELECT count(*) FROM inserted_orgs) AS organizations_inserted,
  (SELECT count(*) FROM inserted_links) AS project_links_inserted;

WITH approved_sites(org_name, site_name, site_slug, service_uuid, project_id, project_name) AS (
  VALUES
    ('Manifest FTS', 'Jongo WebApp', 'jongo-webapp', 'dt0v391xre5rgtp50062tunm', 'ip1hwipx8sn24rd0dni67lb0', 'Manifest FTS'),
    ('Manifest FTS', 'MTFS Brand', 'mtfs-brand', 'qs8dtldmyaubydle9z34vqiq', 'ip1hwipx8sn24rd0dni67lb0', 'Manifest FTS'),
    ('Community Catalyst', 'cc-empowermaps', 'cc-empowermaps', 'ohvcryeup93rm9xqr9g3nhhw', 'kan91vl6yh1h3uoqeboy607f', 'Community Catalyst'),
    ('JoyFeed', 'joyfeed.app', 'joyfeed-app', 'gyn7ag00fyb4g9fydnggxt92', 'cplzvcszywes0ayod4jk4hme', 'JoyFeed'),
    ('Millenion Fitness', 'Millenion Fitness', 'millenion-fitness', 'c2mqv1xjksrkg2wn6eglw3u6', 'sndclvrx7rwe3zii9sm1fdt2', 'Millenion Fitness'),
    ('Daniel Kane', 'Daniel Kane', 'daniel-kane', 'f12mcnqyxf3gtlb04zjsil0u', 'ank4te9xzy8nz96ivyot1aoj', 'Daniel Kane'),
    ('Daniel Kane', 'a3th9r', 'a3th9r', 'dbv03lhfksfllfs2vk62p1dt', 'ank4te9xzy8nz96ivyot1aoj', 'Daniel Kane'),
    ('Emile De Meyer', 'freebling-app', 'freebling-app', 'cgp8wmgqvzwc7nehjli9s0tj', 'ubw2fq966nic1bm0uwhq2bv5', 'Emile De Meyer')
),
org_lookup AS (
  SELECT o.id, o.name
  FROM "Organization" o
  WHERE o."deletedAt" IS NULL
),
inserted_sites AS (
  INSERT INTO "Site" (
    id, "organizationId", slug, name, description,
    "coolifyServiceUuid", "coolifyProjectId", "coolifyProjectName",
    "stagingEnabled", "createdAt", "updatedAt"
  )
  SELECT
    gen_random_uuid(),
    ol.id,
    s.site_slug,
    s.site_name,
    'Imported from approved Coolify ownership mapping',
    s.service_uuid,
    s.project_id,
    s.project_name,
    false,
    now(),
    now()
  FROM approved_sites s
  JOIN org_lookup ol
    ON lower(ol.name) = lower(s.org_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM "Site" existing
    WHERE existing."coolifyServiceUuid" = s.service_uuid
      AND existing."deletedAt" IS NULL
  )
    AND NOT EXISTS (
      SELECT 1
      FROM "Site" existing
      WHERE existing."organizationId" = ol.id
        AND existing.slug = s.site_slug
  )
  RETURNING id
)
SELECT (SELECT count(*) FROM inserted_sites) AS sites_inserted;
