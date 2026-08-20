/**
 * Applying Privacy Mode to the running proxy.
 *
 * Split from lib/privacy-mode.ts so everything that decides WHAT to write stays
 * pure and testable, and only the part that talks to a host lives here.
 */

import bcrypt from "bcryptjs";
import { runHostScript } from "@/lib/ssh-exec";
import {
  buildDisableScript,
  buildEnableScript,
  buildInspectScript,
  buildPrivacyRouterYaml,
  parseInspectOutput
} from "@/lib/privacy-mode";

export type PrivacyApplyResult =
  | { ok: true; detail: string }
  | { ok: false; reason: string; message: string };

/** Cost 10: verified on the proxy for every request, so this must stay cheap. */
const BCRYPT_ROUNDS = 10;

export async function hashPrivacyPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Put the site behind Basic Auth.
 *
 * Reads the site's live Traefik rule first and refuses if it cannot be found —
 * writing a router with a guessed rule risks either matching nothing (privacy
 * silently off) or matching more than intended.
 */
export async function enablePrivacyMode(input: {
  resourceUuid: string;
  username: string;
  password: string;
}): Promise<PrivacyApplyResult> {
  const inspect = await runHostScript(buildInspectScript(input.resourceUuid), { timeoutMs: 30_000 });
  if (!inspect.ok) {
    const stderr = `${inspect.stderr} ${inspect.transportError ?? ""}`;
    if (stderr.includes("no_container")) {
      return {
        ok: false,
        reason: "no_container",
        message: "This app has no running container, so privacy mode could not be applied."
      };
    }
    if (stderr.includes("no_https_router")) {
      return {
        ok: false,
        reason: "no_https_router",
        message: "This app has no HTTPS route yet, so there is nothing to put a password in front of."
      };
    }
    return {
      ok: false,
      reason: "inspect_failed",
      message: "Could not read this app's routing from the server, so privacy mode was not applied."
    };
  }

  const parsed = parseInspectOutput(inspect.stdout);
  if (!parsed) {
    return {
      ok: false,
      reason: "inspect_unreadable",
      message: "The server's reply about this app's routing could not be read, so privacy mode was not applied."
    };
  }

  const yaml = buildPrivacyRouterYaml({
    resourceUuid: input.resourceUuid,
    rule: parsed.rule,
    containerName: parsed.container,
    containerPort: parsed.port,
    username: input.username,
    passwordHash: await hashPrivacyPassword(input.password)
  });

  const write = await runHostScript(buildEnableScript(input.resourceUuid, yaml), { timeoutMs: 30_000 });
  if (!write.ok || !write.stdout.includes("OK=written")) {
    return {
      ok: false,
      reason: "write_failed",
      message: "The server refused to save the privacy settings, so the site is still public."
    };
  }

  return { ok: true, detail: `Privacy mode applied to ${parsed.rule}.` };
}

/** Remove the privacy router, returning the site to its normal public route. */
export async function disablePrivacyMode(resourceUuid: string): Promise<PrivacyApplyResult> {
  const result = await runHostScript(buildDisableScript(resourceUuid), { timeoutMs: 30_000 });
  if (!result.ok || !result.stdout.includes("OK=removed")) {
    return {
      ok: false,
      reason: "remove_failed",
      // Stated plainly: the danger on this path is assuming the site is public
      // again and announcing a launch nobody can reach.
      message: "The server refused to remove the privacy settings, so the site may still ask for a password."
    };
  }
  return { ok: true, detail: "Privacy mode removed." };
}
