const { PrismaClient } = require("@prisma/client");
const { hashSync } = require("bcryptjs");

const db = new PrismaClient();

const passwordHash = hashSync("password123", 10);

async function resetDatabase() {
  await db.auditLog.deleteMany();
  await db.apiToken.deleteMany();
  await db.siteCollaborator.deleteMany();
  await db.collaborator.deleteMany();
  await db.deployment.deleteMany();
  await db.environment.deleteMany();
  await db.site.deleteMany();
  await db.organization.deleteMany();
  await db.user.deleteMany();
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log("DATABASE_URL is not set. Skipping database seed.");
    return;
  }

  await resetDatabase();

  const [alex, priya, morgan] = await Promise.all([
    db.user.create({
      data: {
        email: "alex@acme.co",
        fullName: "Alex Kim",
        passwordHash,
        emailVerified: true,
        authProvider: "local"
      }
    }),
    db.user.create({
      data: {
        email: "priya@acme.co",
        fullName: "Priya Shah",
        passwordHash,
        emailVerified: true,
        authProvider: "local"
      }
    }),
    db.user.create({
      data: {
        email: "morgan@northstar.io",
        fullName: "Morgan Lee",
        passwordHash,
        emailVerified: true,
        authProvider: "local"
      }
    })
  ]);

  const acme = await db.organization.create({
    data: {
      slug: "acme-co",
      name: "Acme Co",
      description: "Marketing and demand-gen operations with weekly release cadence.",
      ownerId: alex.id,
      collaborators: {
        create: [
          { userId: alex.id, role: "owner", grantedById: alex.id },
          { userId: priya.id, role: "operator", grantedById: alex.id }
        ]
      }
    }
  });

  const northstar = await db.organization.create({
    data: {
      slug: "northstar-labs",
      name: "Northstar Labs",
      description: "Client portal operations with active staging validation before promotion.",
      ownerId: morgan.id,
      collaborators: {
        create: [{ userId: morgan.id, role: "owner", grantedById: morgan.id }]
      }
    }
  });

  const mainSite = await db.site.create({
    data: {
      organizationId: acme.id,
      slug: "main-marketing-site",
      name: "Main Marketing Site",
      coolifyServiceId: "site-main",
      gitRepositoryUrl: "https://github.com/manifest-fts/jongo-os"
    }
  });

  const portalSite = await db.site.create({
    data: {
      organizationId: northstar.id,
      slug: "client-portal",
      name: "Client Portal",
      coolifyServiceId: "site-client-portal",
      gitRepositoryUrl: "https://github.com/manifest-fts/jongo-os"
    }
  });

  const mainProduction = await db.environment.create({
    data: { siteId: mainSite.id, name: "production", isProductionLike: true }
  });
  const mainStaging = await db.environment.create({
    data: { siteId: mainSite.id, name: "staging", isProductionLike: false }
  });
  const portalProduction = await db.environment.create({
    data: { siteId: portalSite.id, name: "production", isProductionLike: true }
  });
  const portalStaging = await db.environment.create({
    data: { siteId: portalSite.id, name: "staging", isProductionLike: false }
  });

  await Promise.all([
    db.deployment.create({
      data: {
        environmentId: mainProduction.id,
        status: "success",
        triggeredById: alex.id,
        commitSha: "a1b2c3d4",
        commitMessage: "Launch campaign refresh",
        logsUrl: "https://example.com/logs/main-production"
      }
    }),
    db.deployment.create({
      data: {
        environmentId: mainStaging.id,
        status: "failed",
        triggeredById: priya.id,
        commitSha: "d4c3b2a1",
        commitMessage: "Sync staging preview",
        logsUrl: "https://example.com/logs/main-staging"
      }
    }),
    db.deployment.create({
      data: {
        environmentId: portalProduction.id,
        status: "success",
        triggeredById: morgan.id,
        commitSha: "0a1b2c3d",
        commitMessage: "Portal hardening pass",
        logsUrl: "https://example.com/logs/portal-production"
      }
    }),
    db.deployment.create({
      data: {
        environmentId: portalStaging.id,
        status: "degraded",
        triggeredById: morgan.id,
        commitSha: "3d2c1b0a",
        commitMessage: "Staging verification",
        logsUrl: "https://example.com/logs/portal-staging"
      }
    })
  ]);

  await Promise.all([
    db.siteCollaborator.create({
      data: { siteId: mainSite.id, userId: alex.id, role: "admin" }
    }),
    db.siteCollaborator.create({
      data: { siteId: portalSite.id, userId: morgan.id, role: "admin" }
    }),
    db.auditLog.create({
      data: {
        organizationId: acme.id,
        actorId: alex.id,
        action: "site_created",
        resourceType: "site",
        resourceId: mainSite.id,
        details: { name: mainSite.name }
      }
    }),
    db.auditLog.create({
      data: {
        organizationId: northstar.id,
        actorId: morgan.id,
        action: "deploy_triggered",
        resourceType: "deployment",
        details: { site: portalSite.name }
      }
    })
  ]);
}

main()
  .then(async () => {
    await db.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await db.$disconnect();
    process.exit(1);
  });
