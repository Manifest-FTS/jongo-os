/**
 * Deciding whether a Coolify resource is THIS app's staging counterpart.
 *
 * This was a closure inside getCoolifyAppStagingCapability, which meant the one
 * rule that decides "attach to that resource" could not be tested. It matters
 * more than it looks, because the same answer is used for two jobs with very
 * different consequences:
 *
 *   - DISPLAY and promote preflight, where guessing generously is mostly
 *     harmless: the worst case is showing staging that exists.
 *   - ENABLING staging, where a wrong guess attaches an app to a DIFFERENT app's
 *     staging site and then syncs production content into it. That is
 *     destructive, and it is the reported bug: adding staging for one app
 *     adopted a neighbouring app's staging and showed its values.
 *
 * So the strictness is a parameter, and the create path asks for `strict`.
 *
 * The permissive rules that caused it, kept here as a record of what not to do:
 *   1. an empty name on either side returned TRUE — a wildcard that matched
 *      anything at all;
 *   2. substring containment in either direction, so "acme" matched
 *      "acme-other-client-staging";
 *   3. a single candidate in the environment was adopted with no name check.
 */

/** Lowercase, alphanumeric-and-dashes, collapsed. */
export function normalizeStagingNameKey(value: string): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Remove environment suffixes so a production app and its staging sibling
 * reduce to the same key. Applied twice because names like `foo-staging-prod`
 * carry two.
 */
export function stripStageHints(value: string): string {
  return value
    .replace(/-(staging|stage|preview|dev|development|prod|production)$/g, "")
    .replace(/-(staging|stage|preview|dev|development|prod|production)$/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export type StagingSiblingVerdict = {
  match: boolean;
  reason:
    | "exact_key"
    | "unnamed_candidate"
    | "unnamed_root"
    | "different_key"
    | "substring_relaxed";
};

/**
 * Whether `candidateName` is the staging counterpart of `rootName`.
 *
 * Strict mode requires the names to reduce to the same key once environment
 * suffixes are stripped — `acme` and `acme-staging` match, `acme` and
 * `acme-two-staging` do not. A name we cannot read is never a match in strict
 * mode: "we could not tell" must not become "yes, attach to it".
 */
export function isStagingSibling(
  rootName: string,
  candidateName: string,
  options: { relaxed?: boolean } = {}
): StagingSiblingVerdict {
  const rootKey = stripStageHints(normalizeStagingNameKey(rootName));
  const candidateKey = stripStageHints(normalizeStagingNameKey(candidateName));

  if (!candidateKey) return { match: Boolean(options.relaxed), reason: "unnamed_candidate" };
  if (!rootKey) return { match: Boolean(options.relaxed), reason: "unnamed_root" };
  if (candidateKey === rootKey) return { match: true, reason: "exact_key" };

  // Containment is how one client's app adopted another's staging. Only offered
  // when the caller has said a wrong guess is survivable.
  if (options.relaxed) {
    if (rootKey.length >= 4 && candidateKey.includes(rootKey)) {
      return { match: true, reason: "substring_relaxed" };
    }
    if (candidateKey.length >= 4 && rootKey.includes(candidateKey)) {
      return { match: true, reason: "substring_relaxed" };
    }
  }

  return { match: false, reason: "different_key" };
}

export type StagingCandidate = { uuid: string; name: string };

export type StagingTargetSelection = {
  selected?: StagingCandidate;
  candidateCount: number;
  matchedCount: number;
  /** True when the pick came from the lone-candidate fallback, not a name match. */
  adoptedWithoutNameMatch: boolean;
};

/**
 * Choose this app's staging target from the resources in its staging environment.
 *
 * `allowLoneCandidateFallback` is the "there is only one thing here, it must be
 * ours" rule. It is genuinely useful for display on a single-app project and
 * genuinely dangerous when enabling staging, so it is opt-in and reported
 * separately when used.
 */
export function pickStagingTarget(
  rootName: string,
  candidates: StagingCandidate[],
  options: { relaxed?: boolean; allowLoneCandidateFallback?: boolean; excludeUuid?: string } = {}
): StagingTargetSelection {
  const sanitized = candidates.filter(
    (candidate) => candidate.uuid.length > 0 && candidate.uuid !== options.excludeUuid
  );

  const matched = sanitized.filter((candidate) => isStagingSibling(rootName, candidate.name, options).match);

  if (matched.length === 0 && options.allowLoneCandidateFallback && sanitized.length === 1) {
    return {
      selected: sanitized[0],
      candidateCount: sanitized.length,
      matchedCount: 0,
      adoptedWithoutNameMatch: true
    };
  }

  return {
    selected: matched[0],
    candidateCount: sanitized.length,
    matchedCount: matched.length,
    adoptedWithoutNameMatch: false
  };
}
