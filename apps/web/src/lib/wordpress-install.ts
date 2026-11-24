/**
 * Finishing a new WordPress site: site title, admin account and address, so it
 * opens ready to use instead of on WordPress's setup screen.
 *
 * That screen is also a takeover risk: until someone completes it, anyone who
 * finds the address can pick the admin password. Jongo now completes it itself
 * right after creating the site.
 *
 * The official WordPress image has no WP-CLI, so a short PHP program runs
 * inside the container and calls WordPress's own wp_install(). The inputs travel
 * base64-encoded inside that program, which only ever moves over the SSH
 * connection's stdin — never a command line, an environment variable or the
 * shell — so a hostile site title can't become a command.
 */

import { randomBytes } from "crypto";
import { isSshHostConfigured, runHostScript } from "./ssh-exec";

export type WordPressInstallConfig = {
  url: string;
  title: string;
  adminUser: string;
  adminEmail: string;
};

export type InstallInputResult =
  | { ok: true; config: WordPressInstallConfig; password: string; generatedPassword: boolean }
  | { ok: false; field: "title" | "adminUser" | "adminEmail" | "adminPassword" | "url"; message: string };

const MIN_PASSWORD = 12;

export function generateWordPressPassword(): string {
  // 20 characters from a set that survives copy-paste and every login form.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789-_!@#%";
  const bytes = randomBytes(20);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** WordPress's own sanitize_user(strict) character set, lowercased. */
export function normalizeAdminUser(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.@-]/g, "").slice(0, 60);
}

export function defaultAdminUser(email: string): string {
  const local = normalizeAdminUser(email.split("@")[0] ?? "");
  return local.length >= 3 && local !== "admin" ? local : "siteowner";
}

/** Validates and fills defaults for what the operator typed (all optional). */
export function buildInstallInput(input: {
  url: string | null | undefined;
  siteName: string;
  title?: unknown;
  adminUser?: unknown;
  adminEmail?: unknown;
  adminPassword?: unknown;
  fallbackEmail: string;
}): InstallInputResult {
  let url: URL;
  try {
    url = new URL(String(input.url ?? ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("scheme");
  } catch {
    return { ok: false, field: "url", message: "The site has no address yet, so WordPress can't be set up." };
  }

  const title = (typeof input.title === "string" && input.title.trim() ? input.title : input.siteName)
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 100);
  if (!title) return { ok: false, field: "title", message: "Enter a site title." };

  const adminEmail = (typeof input.adminEmail === "string" && input.adminEmail.trim() ? input.adminEmail : input.fallbackEmail)
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail) || adminEmail.length > 100) {
    return { ok: false, field: "adminEmail", message: "Enter a valid admin email address." };
  }

  const typedUser = typeof input.adminUser === "string" ? input.adminUser.trim() : "";
  const adminUser = typedUser ? normalizeAdminUser(typedUser) : defaultAdminUser(adminEmail);
  if (typedUser && adminUser !== typedUser.toLowerCase()) {
    return { ok: false, field: "adminUser", message: "Usernames can use letters, numbers, and . _ - @ only." };
  }
  if (adminUser.length < 3) return { ok: false, field: "adminUser", message: "Usernames need at least 3 characters." };
  if (adminUser === "admin") {
    return { ok: false, field: "adminUser", message: "Choose a username other than \"admin\": it's the first one attackers try." };
  }

  const typedPassword = typeof input.adminPassword === "string" ? input.adminPassword : "";
  if (typedPassword && typedPassword.length < MIN_PASSWORD) {
    return { ok: false, field: "adminPassword", message: `Use at least ${MIN_PASSWORD} characters, or leave it blank to have one made for you.` };
  }
  if (typedPassword.length > 200) return { ok: false, field: "adminPassword", message: "That password is too long." };

  return {
    ok: true,
    config: { url: url.origin, title, adminUser, adminEmail },
    password: typedPassword || generateWordPressPassword(),
    generatedPassword: !typedPassword
  };
}

/**
 * Runs inside the WordPress container. Prints exactly one JONGO_INSTALL= line;
 * if WordPress dies first (database not up yet), the shutdown hook reports it
 * as "waiting" so the caller tries again.
 */
export const WP_INSTALL_PHP = String.raw`
$GLOBALS['jongo_done'] = false;
function jongo_out($a) { $GLOBALS['jongo_done'] = true; echo "\nJONGO_INSTALL=" . json_encode($a) . "\n"; exit(0); }
register_shutdown_function(function () {
  if (!$GLOBALS['jongo_done']) { echo "\nJONGO_INSTALL=" . json_encode(['status' => 'waiting', 'error' => 'wordpress_not_ready']) . "\n"; }
});
$in = json_decode(base64_decode($JONGO_PAYLOAD), true);
if (!is_array($in)) jongo_out(['status' => 'failed', 'error' => 'bad_input']);
$root = '/var/www/html';
if (!file_exists("$root/wp-load.php") || !file_exists("$root/wp-config.php")) jongo_out(['status' => 'waiting', 'error' => 'files_not_ready']);
$u = parse_url($in['url']);
$_SERVER['HTTP_HOST'] = $u['host'];
$_SERVER['SERVER_NAME'] = $u['host'];
$_SERVER['HTTPS'] = ($u['scheme'] === 'https') ? 'on' : 'off';
$_SERVER['SERVER_PORT'] = ($u['scheme'] === 'https') ? 443 : 80;
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['REQUEST_METHOD'] = 'GET';
define('WP_INSTALLING', true);
ob_start();
require_once "$root/wp-load.php";
// No "your new site" email with the password in it.
if (!function_exists('wp_new_blog_notification')) { function wp_new_blog_notification() {} }
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
ob_end_clean();
if (is_blog_installed()) jongo_out(['status' => 'already_installed']);
$result = wp_install($in['title'], $in['user'], $in['email'], true, '', wp_slash($in['password']));
if (empty($result['user_id']) || is_wp_error($result['user_id'])) {
  jongo_out(['status' => 'failed', 'error' => 'install_failed']);
}
update_option('siteurl', $in['url']);
update_option('home', $in['url']);
update_option('permalink_structure', '/%postname%/');
jongo_out(['status' => 'installed']);
`;

function shQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildInstallScript(input: { resourceUuid: string; config: WordPressInstallConfig; password: string }): string {
  const payload = Buffer.from(
    JSON.stringify({
      url: input.config.url,
      title: input.config.title,
      user: input.config.adminUser,
      email: input.config.adminEmail,
      password: input.password
    }),
    "utf8"
  ).toString("base64");
  // base64 never contains a quote or backslash, so it is safe inside a PHP
  // single-quoted string; the heredoc below is quoted, so bash expands nothing.
  return `set -uo pipefail
RUUID=${shQuote(input.resourceUuid)}

if docker ps --format '{{.Names}} {{.Image}}' | grep -qE 'coolify-helper'; then
  echo 'JONGO_INSTALL={"status":"waiting","error":"deploy_in_progress"}'
  exit 0
fi

CONTAINERS=$(docker ps --format '{{.Names}}' | grep -E "(^|-)$RUUID($|-)" || true)
WP_CONTAINER=""
while IFS= read -r c; do
  [ -n "$c" ] || continue
  case "$c" in wordpress-*) WP_CONTAINER="$c";; esac
done <<EOF
$CONTAINERS
EOF

[ -n "$WP_CONTAINER" ] || { echo 'JONGO_INSTALL={"status":"waiting","error":"no_wordpress_container"}'; exit 0; }

docker exec -i "$WP_CONTAINER" php <<'JONGOPHPEOF'
<?php
$JONGO_PAYLOAD = '${payload}';
${WP_INSTALL_PHP}
JONGOPHPEOF
`;
}

export type InstallAttempt =
  | { status: "installed" | "already_installed" }
  | { status: "waiting"; reason: string }
  | { status: "failed"; reason: string };

export function parseInstallOutput(stdout: string): InstallAttempt {
  const lines = stdout.split("\n").filter((line) => line.startsWith("JONGO_INSTALL="));
  const last = lines[lines.length - 1];
  if (!last) return { status: "waiting", reason: "no_report" };
  try {
    const parsed = JSON.parse(last.slice("JONGO_INSTALL=".length));
    if (parsed.status === "installed" || parsed.status === "already_installed") return { status: parsed.status };
    if (parsed.status === "waiting") return { status: "waiting", reason: String(parsed.error ?? "not_ready") };
    return { status: "failed", reason: String(parsed.error ?? "install_failed") };
  } catch {
    return { status: "waiting", reason: "unreadable_report" };
  }
}

export async function attemptWordPressInstall(input: {
  resourceUuid: string;
  config: WordPressInstallConfig;
  password: string;
}): Promise<InstallAttempt> {
  if (!isSshHostConfigured()) return { status: "failed", reason: "ssh_not_configured" };
  if (!input.resourceUuid.trim()) return { status: "failed", reason: "not_linked" };
  const run = await runHostScript(buildInstallScript(input), { timeoutMs: 90_000 });
  if (run.transportError) return { status: "waiting", reason: "host_unreachable" };
  return parseInstallOutput(run.stdout);
}

/**
 * Keep trying while the new containers start, the database comes up and the
 * image copies WordPress into place. Usually one to three minutes.
 */
export async function installWordPressWhenReady(
  input: { resourceUuid: string; config: WordPressInstallConfig; password: string },
  options: { deadlineMs?: number; intervalMs?: number; attempt?: typeof attemptWordPressInstall } = {}
): Promise<InstallAttempt> {
  const deadline = Date.now() + (options.deadlineMs ?? 5 * 60_000);
  const attempt = options.attempt ?? attemptWordPressInstall;
  let last: InstallAttempt = { status: "waiting", reason: "not_started" };
  while (Date.now() < deadline) {
    last = await attempt(input);
    if (last.status !== "waiting") return last;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 10_000));
  }
  return last;
}

export function describeInstallProblem(reason: string): string {
  switch (reason) {
    case "ssh_not_configured":
      return "Jongo can't reach the server to finish setting up WordPress.";
    case "install_failed":
      return "WordPress refused the setup. Try again; if it keeps failing, contact support.";
    case "deploy_in_progress":
    case "no_wordpress_container":
    case "files_not_ready":
    case "wordpress_not_ready":
      return "The site was still starting when setup timed out. Try again in a minute.";
    default:
      return "WordPress setup didn't finish. Try again in a minute.";
  }
}
