/**
 * What the staging page should claim, given what the probe came back with.
 *
 * The page re-probes Coolify on every render, and it auto-refreshes every 12
 * seconds. Coolify rate limits at 200 requests/minute, so a busy moment — or
 * any transient error — returns `detected: false`, which the page rendered as
 * "Staging is not configured for this site", complete with instructions to go
 * and provision it. Twelve seconds later the probe succeeds and the page says
 * the opposite. That is the instability: not flapping infrastructure, but a
 * failed lookup being reported as a definitive negative.
 *
 * The rule, borrowed from resolveBackupViewCapability which fixed exactly this
 * for backups: an ABSENT answer and an UNOBTAINABLE answer are different
 * things, and only the first one may be stated as fact.
 */

export type StagingViewState = {
  /** Staging is known to be usable. */
  configured: boolean;
  /** The probe could not get an answer. Never render a negative on this. */
  unknown: boolean;
  /** Headline for the panel. */
  title: string;
  /** Sentence beneath it. */
  detail: string;
  /** Hide sync/promote controls. True only when we actually know. */
  hideControls: boolean;
};

export function resolveStagingViewState(input: {
  environmentReady: boolean;
  targetAttached: boolean;
  /** Site-level opt-in. */
  stagingEnabled: boolean;
  /** True when Coolify was rate limiting or the probe threw. */
  probeFailed?: boolean;
  /** Last known good answer, when one exists. */
  lastKnownConfigured?: boolean | null;
}): StagingViewState {
  if (input.environmentReady && input.targetAttached) {
    return {
      configured: true,
      unknown: false,
      title: "Staging Environment",
      detail: "Staging is active. Validate changes here before promoting to production.",
      hideControls: false
    };
  }

  if (input.probeFailed) {
    // Prefer the last answer we trusted over the one we could not get. Telling
    // someone their staging site has vanished, when we simply could not ask, is
    // worse than admitting we could not ask.
    if (input.lastKnownConfigured) {
      return {
        configured: true,
        unknown: true,
        title: "Staging Environment",
        detail:
          "Staging was active when last checked. The platform is not responding right now, so this may be out of date.",
        hideControls: false
      };
    }
    return {
      configured: false,
      unknown: true,
      title: "Staging status unavailable",
      detail:
        "The platform could not be reached to check this app's staging environment. This is usually temporary — it does not mean staging is missing.",
      // Controls stay VISIBLE: the API re-checks before acting and will refuse
      // precisely if staging is genuinely absent, which beats hiding a working
      // button because one lookup failed.
      hideControls: false
    };
  }

  if (!input.stagingEnabled) {
    return {
      configured: false,
      unknown: false,
      title: "Staging Environment",
      detail: "Staging is not enabled for this app. Enable it in Settings to create a staging copy.",
      hideControls: true
    };
  }

  return {
    configured: false,
    unknown: false,
    title: "Staging Not Configured",
    detail:
      "Staging is enabled but no staging environment was found for this app. Jongo will attempt to provision one; if it does not appear, provision it in your infrastructure panel.",
    hideControls: true
  };
}
