# Phase 1 integration verification — 2026-10-20

Scope: Jongo OS integration review only. No mfts-2026 changes, commits, resets, deployments or configured-database migrations.

## Observed baseline and fix

- Root `npm test`: **1 failed, 1,904 passed, 124 suites / 1,905 tests**. The reported earlier 15 failures were not reproduced in the current working tree; other agents' form, shell and footer changes were already present and passing.
- The remaining client-parent integration assertion omitted the dataset page's explicit `variant: "draft"` repository argument. Updated it to assert both exactly one call and the complete draft-only scoped arguments. No implementation, authorization or entitlement behavior was changed in this pass.
- Reviewed the existing parent helper's fresh persisted principal, organization-versus-site branches and minimal `id`/`name` projection. Site-only rendering does not invoke the broad client workspace repository or render its navigation, summary or counts. Existing tests retain revocation, deleted identity, wrong tenant/dataset, independent child-page guards and a child-page inventory tripwire.
- Form preservation tests exercise actual form handlers, including empty strings, reference metadata and explicit unsetting. Existing shell/footer tests passed without further edits. No speculative source patch or permissive capability mock was introduced to make the suite pass.

## Final executed verification

`npm run verify:local` completed successfully (exit 0):

1. Repository TypeScript check passed.
2. Full root test delegation: **124 suites passed; 1,905 tests passed; zero failed**.
3. Disposable PostgreSQL harness: **17 checks passed** — 14 integrity and 3 direct-SQL concurrency protocol checks. Temporary cluster stopped and its directory removed.

The first verifier attempt stopped at TypeScript because a newly used assertion matcher was not supported by installed Vitest 2. It was replaced with supported call-count plus argument matchers before the successful full rerun.

Tests were run with `DATABASE_URL` overridden to an unreachable loopback test target. The PostgreSQL harness independently uses its sanitized environment and disposable cluster. No configured application database was migrated.

## Limits

These results do not certify a production build, browser acceptance, complete Phase 1–2 delivery, real Prisma-service concurrency, live provider integration or an exhaustive endpoint/PII audit. The parent shell is not authorization for an API or dataset: independent request-level authorization remains required. No production operations were performed.