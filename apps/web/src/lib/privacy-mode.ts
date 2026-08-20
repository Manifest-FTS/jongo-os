/**
 * Privacy Mode: HTTP Basic Auth in front of a live site.
 *
 * ## Why a Traefik file-provider router
 *
 * Coolify owns each site's Traefik configuration through container labels, so
 * the obvious move — appending a `basicauth` middleware to the site's existing
 * router — means rewriting labels and recreating the container. That is a
 * redeploy, with downtime, every time someone flips a switch, and Coolify would
 * overwrite it on its next deploy anyway.
 *
 * Instead this writes a SEPARATE router into the proxy's watched dynamic
 * directory (`--providers.file.directory=/traefik/dynamic/`, `watch=true`) with
 * a higher priority than the label-defined one. Traefik picks the
 * highest-priority router whose rule matches, so ours takes the traffic, applies
 * BasicAuth, and forwards to the same container. Enabling is one file written;
 * disabling is one file removed; both apply in about a second with no restart,
 * no redeploy, and nothing about the site's own configuration touched.
 *
 * The rule is COPIED from the site's live Traefik labels rather than rebuilt
 * from stored domains. A router that matches a slightly different host set than
 * the real one would leave part of the site reachable without the password,
 * which is the one failure this feature cannot have.
 *
 * The upstream is the container's Docker DNS name, not a Traefik service
 * reference. Cross-provider references (`name@docker`) depend on how Traefik
 * derived that service's name, which is not ours to predict; the proxy is
 * attached to every site network, so the DNS name always resolves.
 */

import { randomBytes } from "node:crypto";

/** Marks files this feature owns, so cleanup can never touch Coolify's own. */
export const PRIVACY_FILE_PREFIX = "jongo-privacy-";

/** Coolify's own routers use rule-length priorities; this clears them all. */
export const PRIVACY_ROUTER_PRIORITY = 100000;

export const DEFAULT_PRIVACY_USERNAME = "jongo";

/**
 * A password that is actually a password.
 *
 * The UI this replaces picked from ten adjectives and ten nouns — one hundred
 * possible values, which a single request-per-second loop exhausts in under two
 * minutes. This is 64 bits from a CSPRNG, rendered in an unambiguous alphabet
 * (no O/0/I/l) because these get read aloud and typed by hand.
 */
const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

export function generatePrivacyPassword(length = 14): string {
  if (length < 12) throw new Error("Privacy password must be at least 12 characters.");
  // Rejection-free because the alphabet is 32 long: every 5-bit slice is valid,
  // so no byte is discarded and no value is favoured.
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  }
  return out;
}

/**
 * Usernames go into an htpasswd line, where a colon starts the hash field.
 * Anything outside this set is dropped rather than escaped: an operator typing
 * an odd character gets a slightly shorter username, not a broken auth file.
 */
export function normalizePrivacyUsername(value: string | null | undefined): string {
  const cleaned = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "")
    .slice(0, 32);
  return cleaned || DEFAULT_PRIVACY_USERNAME;
}

/** Single-quote a value for bash, escaping any embedded quote. */
export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Traefik reads these files as YAML. Rules contain backticks and quotes, and a
 * bcrypt hash contains `$`, so both are emitted as double-quoted scalars with
 * the only two characters YAML treats specially inside them escaped.
 */
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export type PrivacyRouterInput = {
  /** Coolify resource uuid — namespaces every generated name. */
  resourceUuid: string;
  /** Verbatim Traefik rule copied from the site's live labels. */
  rule: string;
  /** Container DNS name the proxy forwards to. */
  containerName: string;
  /** Port the container serves on. */
  containerPort: number;
  username: string;
  /** bcrypt hash of the password. Never the password itself. */
  passwordHash: string;
};

export function buildPrivacyRouterYaml(input: PrivacyRouterInput): string {
  const id = `${PRIVACY_FILE_PREFIX}${input.resourceUuid}`;
  if (!input.rule.trim()) {
    throw new Error("Refusing to build a privacy router with an empty rule — it would match nothing or everything.");
  }
  if (!/^\$2[aby]\$/.test(input.passwordHash)) {
    // A plaintext or mis-hashed value here would be written to disk and, worse,
    // accepted by Traefik as a literal password.
    throw new Error("Privacy password hash must be bcrypt.");
  }

  return `# Managed by Jongo — Privacy Mode for ${input.resourceUuid}.
# Written and removed by lib/privacy-mode.ts. Do not edit by hand: toggling
# Privacy Mode in Jongo overwrites this file, and disabling it deletes the file.
http:
  routers:
    ${id}:
      rule: ${yamlString(input.rule)}
      entryPoints:
        - https
      priority: ${PRIVACY_ROUTER_PRIORITY}
      middlewares:
        - ${id}-auth
      service: ${id}-svc
      tls:
        certResolver: letsencrypt
  services:
    ${id}-svc:
      loadBalancer:
        servers:
          - url: ${yamlString(`http://${input.containerName}:${input.containerPort}`)}
  middlewares:
    ${id}-auth:
      basicAuth:
        removeHeader: true
        users:
          - ${yamlString(`${input.username}:${input.passwordHash}`)}
`;
}

/** Where the file lives on the host. Traefik watches this directory. */
export function privacyFilePath(resourceUuid: string): string {
  return `/data/coolify/proxy/dynamic/${PRIVACY_FILE_PREFIX}${resourceUuid}.yaml`;
}

/**
 * Read what Traefik is actually serving for this resource.
 *
 * Emits `RULE=`, `CONTAINER=` and `PORT=` for the caller to parse. The rule is
 * taken from the https router label, which is the one carrying real traffic —
 * the http router only redirects.
 */
export function buildInspectScript(resourceUuid: string): string {
  const uuid = shellQuote(resourceUuid);
  return `set -uo pipefail
UUID=${uuid}
# The application container for this Coolify resource. Coolify names service
# containers <service>-<uuid>, and labels them with the resource uuid.
CONTAINER=""
for c in $(docker ps --format '{{.Names}}'); do
  id=$(docker inspect -f '{{ index .Config.Labels "coolify.serviceId" }}' "$c" 2>/dev/null)
  if [ "$id" = "$UUID" ]; then CONTAINER="$c"; break; fi
done
if [ -z "$CONTAINER" ]; then
  case "$(docker ps --format '{{.Names}}' | grep -c -- "$UUID")" in
    0) echo "ERROR=no_container" >&2; exit 2 ;;
  esac
  CONTAINER=$(docker ps --format '{{.Names}}' | grep -- "$UUID" | head -1)
fi

# Prefer the https router's rule: it is the one serving real traffic.
RULE=$(docker inspect -f '{{range $k,$v := .Config.Labels}}{{println $k "=" $v}}{{end}}' "$CONTAINER" 2>/dev/null \\
  | grep -E '^traefik\\.http\\.routers\\.https-.*\\.rule = ' | head -1 | sed 's/^[^=]*= //')
if [ -z "$RULE" ]; then echo "ERROR=no_https_router" >&2; exit 3; fi

PORT=$(docker inspect -f '{{range $p,$v := .Config.ExposedPorts}}{{println $p}}{{end}}' "$CONTAINER" 2>/dev/null \\
  | head -1 | cut -d/ -f1)
[ -n "$PORT" ] || PORT=80

echo "CONTAINER=$CONTAINER"
echo "PORT=$PORT"
echo "RULE=$RULE"
`;
}

/** Write the router file. Traefik picks it up within about a second. */
export function buildEnableScript(resourceUuid: string, yaml: string): string {
  const path = shellQuote(privacyFilePath(resourceUuid));
  return `set -uo pipefail
DIR=/data/coolify/proxy/dynamic
[ -d "$DIR" ] || { echo "ERROR=no_dynamic_dir" >&2; exit 2; }
TMP=$(mktemp "$DIR/.jongo-privacy.XXXXXX") || { echo "ERROR=tmp_failed" >&2; exit 3; }
cat > "$TMP" <<'JONGO_PRIVACY_YAML'
${yaml}JONGO_PRIVACY_YAML
chmod 644 "$TMP"
# Atomic: Traefik watches this directory, and a half-written router would be
# read and rejected, briefly leaving the site with no privacy router at all.
mv -f "$TMP" ${path} || { rm -f "$TMP"; echo "ERROR=write_failed" >&2; exit 4; }
echo "OK=written"
`;
}

/** Remove the router file, returning the site to Coolify's own router. */
export function buildDisableScript(resourceUuid: string): string {
  const path = shellQuote(privacyFilePath(resourceUuid));
  return `set -uo pipefail
rm -f ${path} || { echo "ERROR=remove_failed" >&2; exit 2; }
echo "OK=removed"
`;
}

/** Parse the inspect script's output. */
export function parseInspectOutput(stdout: string): { container: string; port: number; rule: string } | null {
  const container = /^CONTAINER=(.*)$/m.exec(stdout)?.[1]?.trim() ?? "";
  const portRaw = /^PORT=(.*)$/m.exec(stdout)?.[1]?.trim() ?? "";
  // Greedy to end-of-line only: a rule legitimately contains "=" inside
  // Host(`...`) expressions, so stopping at the first one truncates it.
  const rule = /^RULE=(.*)$/m.exec(stdout)?.[1]?.trim() ?? "";
  const port = Number(portRaw);
  if (!container || !rule || !Number.isFinite(port) || port <= 0) return null;
  return { container, port, rule };
}
