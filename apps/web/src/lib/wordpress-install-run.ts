import { decryptSecret } from "./secret-box";
import {
  describeInstallProblem,
  installWordPressWhenReady,
  type InstallAttempt,
  type WordPressInstallConfig
} from "./wordpress-install";

export type SiteInstallOutcome = {
  state: "installed" | "already_installed" | "running" | "failed";
  message: string;
};

const STEP_LABEL = "Setting up WordPress (title and admin account)";
const RUNNING_STALE_MS = 10 * 60_000;

/**
 * Run (or re-run) the first-time setup for one site from what is stored on it,
 * and record the result. Safe to call twice: WordPress that is already set up
 * is reported, never set up again.
 */
export async function runSiteWordPressInstall(
  db: any,
  siteId: string,
  options: { deadlineMs?: number } = {}
): Promise<SiteInstallOutcome> {
  const { reportStep } = await import("./progress");
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { id: true, coolifyServiceUuid: true, wpInstallConfig: true, wpAdminPasswordEnc: true, wpInstallState: true }
  });
  const config = site?.wpInstallConfig as WordPressInstallConfig | null;
  if (!site || !config?.url) {
    return { state: "failed", message: "This site has no WordPress setup to finish." };
  }
  if (site.wpInstallState === "installed" || site.wpInstallState === "already_installed") {
    return { state: site.wpInstallState, message: "WordPress is already set up." };
  }

  let password: string;
  try {
    password = decryptSecret(String(site.wpAdminPasswordEnc ?? ""));
  } catch {
    await db.site.update({ where: { id: siteId }, data: { wpInstallState: "failed", wpInstallError: "password_unreadable" } });
    return { state: "failed", message: "The saved admin password can't be read. Contact support to finish setup." };
  }

  // Claim the attempt. Another one already running (a second click, a second
  // tab) gets told so instead of installing twice; one that died with the
  // server stops counting after RUNNING_STALE_MS.
  const now = new Date();
  const claimed = await db.site.updateMany({
    where: {
      id: siteId,
      OR: [
        { wpInstallState: { not: "running" } },
        { wpInstallStartedAt: null },
        { wpInstallStartedAt: { lt: new Date(now.getTime() - RUNNING_STALE_MS) } }
      ]
    },
    data: { wpInstallState: "running", wpInstallError: null, wpInstallStartedAt: now }
  });
  if (claimed.count !== 1) {
    return { state: "running", message: "WordPress is already being set up. This takes a minute or two." };
  }
  reportStep("install", STEP_LABEL, "active");
  let attempt: InstallAttempt;
  try {
    attempt = await installWordPressWhenReady(
      { resourceUuid: String(site.coolifyServiceUuid ?? ""), config, password },
      { deadlineMs: options.deadlineMs }
    );
  } catch (error) {
    console.error("[wordpress-install] unexpected error", error);
    attempt = { status: "failed", reason: "unexpected" };
  }

  if (attempt.status === "installed" || attempt.status === "already_installed") {
    await db.site.update({
      where: { id: siteId },
      data: {
        wpInstallState: attempt.status,
        wpInstallError: null,
        wpInstalledAt: new Date(),
        // Someone else's setup means our password was never used: drop it.
        ...(attempt.status === "already_installed" ? { wpAdminPasswordEnc: null } : {})
      }
    });
    reportStep("install", STEP_LABEL, "done");
    return attempt.status === "installed"
      ? { state: "installed", message: "WordPress is set up and ready to sign in." }
      : {
          state: "already_installed",
          message: "WordPress had already been set up before Jongo could finish it. Check the users in WordPress and change any you don't recognise."
        };
  }

  const reason = "reason" in attempt ? attempt.reason : "install_failed";
  await db.site.update({ where: { id: siteId }, data: { wpInstallState: "failed", wpInstallError: reason } });
  const message = describeInstallProblem(reason);
  reportStep("install", STEP_LABEL, "failed", message);
  return { state: "failed", message };
}
