/** Run with the repository's run-typescript.cjs launcher. No dotenv loading. */
import { assertReviewedSnapshot, ImportError } from "../apps/web/src/lib/cms/import/reader";
import type { ImportOptions } from "../apps/web/src/lib/cms/import/service";

export function parseArguments(argv: string[]): ImportOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (flags.has(key) || values.has(key)) throw new ImportError("arguments");
    if (["--apply", "--dry-run"].includes(key)) { flags.add(key); continue; }
    if (!["--file", "--dataset-id", "--actor-id", "--confirm-dataset", "--expected-sha256"].includes(key) || !argv[index + 1] || argv[index + 1].startsWith("--")) throw new ImportError("arguments");
    values.set(key, argv[++index]);
  }
  if (!values.has("--file") || !values.has("--dataset-id") || !values.has("--actor-id") ||
      (flags.has("--apply") && flags.has("--dry-run")) || (!flags.has("--apply") && (values.has("--confirm-dataset") || values.has("--expected-sha256")))) throw new ImportError("arguments");
  const expectedSha256 = flags.has("--apply") ? assertReviewedSnapshot(values.get("--expected-sha256")) : undefined;
  return { file: values.get("--file")!, datasetId: values.get("--dataset-id")!, actorId: values.get("--actor-id")!,
    apply: flags.has("--apply"), confirmDataset: values.get("--confirm-dataset"), expectedSha256 };
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const args = parseArguments(argv);
    // Dry-run must not even initialize Prisma or load application DB modules.
    if (!args.apply) {
      const { planImport } = await import("../apps/web/src/lib/cms/import/planner");
      const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
      if (!uuid.test(args.actorId) || !uuid.test(args.datasetId)) throw new ImportError("scope");
      console.log(JSON.stringify({ ...(await planImport(args.file)).report, mode: "dry-run", applied: 0 }, null, 2));
    } else {
      // Validate environment BEFORE importing the policy/DB bridge.
      const { assertLocalDatabase } = await import("../apps/web/src/lib/cms/import/local-database");
      assertLocalDatabase();
      if (args.confirmDataset !== args.datasetId) throw new ImportError("confirmation_required");
      // Reject changed/unreviewed input before even loading the DB bridge.
      // The service independently replans and compares its retained snapshot.
      const { planImport } = await import("../apps/web/src/lib/cms/import/planner");
      assertReviewedSnapshot(args.expectedSha256, (await planImport(args.file)).snapshot.sha256);
      const { importSanity } = await import("../apps/web/src/lib/cms/import/service");
      try { console.log(JSON.stringify(await importSanity(args), null, 2)); }
      finally { const { closeDb } = await import("../apps/web/src/lib/db"); await closeDb(); }
    }
  } catch (error) {
    console.error(error instanceof ImportError ? error.message : "CMS import unavailable.");
    process.exitCode = 1;
  }
}
if (require.main === module) void main();