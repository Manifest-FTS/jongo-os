import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Minimal on purpose: the only thing this adds is the `@/` alias.
 *
 * Every test before this one imported its subject relatively (`./thing`),
 * because without an alias a test that imports `@/lib/thing` fails to resolve
 * and reports "no tests" rather than a helpful error. That quietly restricted
 * unit tests to modules whose own imports were all relative — anything using
 * the alias the app itself uses could not be covered at all.
 *
 * Resolution mirrors tsconfig.json's `paths`, so a module imports the same way
 * whether Next or vitest is doing the resolving.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  }
});
