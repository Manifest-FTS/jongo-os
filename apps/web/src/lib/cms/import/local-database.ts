import { ImportError } from "./reader";

/** No dotenv, production defaults, generic postgres DB or URL option override.
 * Loopback alone cannot rule out a tunnel; service also checks server identity. */
export function assertLocalDatabase(env: NodeJS.ProcessEnv = process.env,
  prefixes: readonly ("cms_import_test_" | "cms_release_test_")[] = ["cms_import_test_"]): string {
  try {
    const url = new URL(env.DATABASE_URL ?? "");
    const name = env.DATABASE_NAME;
    if (env.NODE_ENV === "production" || !name || !/^[a-z0-9_]+$/.test(name) ||
        !prefixes.some(prefix => name.startsWith(prefix) && name.length > prefix.length) ||
        !["postgres:", "postgresql:"].includes(url.protocol) || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
        decodeURIComponent(url.pathname) !== `/${name}` || url.hash ||
        [...url.searchParams].some(([key, value]) => key !== "schema" || value !== "public")) throw 0;
    return name;
  } catch { throw new ImportError("isolated_database_required"); }
}