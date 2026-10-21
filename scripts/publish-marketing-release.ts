/** Run with the repository's run-typescript.cjs launcher. No dotenv loading.
 * Local isolated databases only; there is no HTTP publishing transport. */
import { ImportError } from "../apps/web/src/lib/cms/import/reader";

type Command = "publish" | "unpublish" | "rollback";
export type ReleaseArguments = {
  command: Command; datasetId: string; actorId: string; expectedRevision: number;
  revisionIds: string[]; publicOrigins: string[]; releaseId?: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const repeatable = new Set(["--revision-id", "--public-origin"]);
const allowed: Record<Command, string[]> = {
  publish: ["--dataset-id", "--actor-id", "--confirm-dataset", "--expected-revision", "--revision-id", "--public-origin"],
  unpublish: ["--dataset-id", "--actor-id", "--confirm-dataset", "--expected-revision"],
  rollback: ["--dataset-id", "--actor-id", "--confirm-dataset", "--expected-revision", "--release-id"]
};

export function parseArguments(argv: string[]): ReleaseArguments {
  const [command, ...rest] = argv;
  if (command !== "publish" && command !== "unpublish" && command !== "rollback") throw new ImportError("arguments");
  const values = new Map<string, string[]>();
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index], value = rest[index + 1];
    if (!allowed[command].includes(key) || !value || value.startsWith("--") || (values.has(key) && !repeatable.has(key))) throw new ImportError("arguments");
    values.set(key, [...(values.get(key) ?? []), value]);
    index++;
  }
  const one = (key: string) => values.get(key)?.[0];
  const datasetId = one("--dataset-id"), actorId = one("--actor-id"), expected = one("--expected-revision");
  if (!datasetId || !actorId || !expected || !/^\d{1,10}$/.test(expected) || !uuid.test(datasetId) || !uuid.test(actorId)) throw new ImportError("arguments");
  if (one("--confirm-dataset") !== datasetId) throw new ImportError("confirmation_required");
  const result: ReleaseArguments = { command, datasetId, actorId, expectedRevision: Number(expected),
    revisionIds: values.get("--revision-id") ?? [], publicOrigins: values.get("--public-origin") ?? [] };
  if (command === "publish" && (!result.revisionIds.length || !result.publicOrigins.length)) throw new ImportError("arguments");
  if (command === "rollback") {
    const releaseId = one("--release-id");
    if (!releaseId || !uuid.test(releaseId)) throw new ImportError("arguments");
    result.releaseId = releaseId;
  }
  return result;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let db: { $disconnect(): Promise<void> } | null = null;
  try {
    const args = parseArguments(argv);
    // Validate environment BEFORE importing any DB/policy module.
    const { assertLocalDatabase } = await import("../apps/web/src/lib/cms/import/local-database");
    const databaseName = assertLocalDatabase(process.env, ["cms_import_test_", "cms_release_test_"]);
    const { getDeliveryDb } = await import("../apps/web/src/lib/cms/delivery-db");
    const client = getDeliveryDb();
    db = client;
    // Loopback URLs can still be tunnels; require the server's own identity too.
    const identity = await client.$queryRaw`SELECT current_database() AS name, inet_server_addr()::text AS address` as Array<{ name: string; address: string }>;
    if (identity[0]?.name !== databaseName || !["127.0.0.1/32", "127.0.0.1", "::1/128", "::1"].includes(identity[0]?.address)) throw new ImportError("isolated_database_required");
    const service = await import("../apps/web/src/lib/cms/marketing-publication");
    const receipt = args.command === "publish"
      ? await service.createMarketingRelease(args.actorId, args.datasetId, args.revisionIds, args.expectedRevision, { publicOrigins: args.publicOrigins })
      : args.command === "unpublish"
        ? await service.unpublishMarketing(args.actorId, args.datasetId, args.expectedRevision)
        : await service.rollbackMarketingRelease(args.actorId, args.datasetId, args.releaseId!, args.expectedRevision);
    console.log(JSON.stringify(receipt, null, 2));
  } catch (error) {
    const reported = (error as { code?: unknown } | null)?.code;
    const code = error instanceof ImportError ? error.code
      : error instanceof Error && error.name === "CmsDocumentError" && typeof reported === "string" ? reported : "unavailable";
    console.error(`CMS release ${code}.`);
    process.exitCode = 1;
  } finally {
    if (db) await db.$disconnect().catch(() => undefined);
  }
}
if (require.main === module) void main();
