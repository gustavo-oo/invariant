# Deployment record

## Live repository

- Repository: <https://github.com/gustavo-oo/invariant> (public, default branch
  `main`)
- The shipped workflow is `.github/workflows/invariant.yml`. The required check
  is the plain job **`invariant-verdict`**, pinned to the GitHub Actions app
  (`integration_id: 15368`).

## Protection ruleset

The ruleset was imported from `.invariant/protection.ruleset.json`:

- ruleset **`invariant`**, id **26057771**, target `branch`, enforcement
  `active`, default branch only;
- required status check `invariant-verdict`, pinned to app `15368`, strict
  (branches must be up to date);
- pull-request rule: code-owner review required, one approving review, stale
  reviews dismissed;
- `non_fast_forward` enabled;
- `bypass_actors: []`.

The ruleset was verified with:

```bash
gh api repos/gustavo-oo/invariant/rulesets/26057771
```

## The gate demonstrated red

Demo PR: <https://github.com/gustavo-oo/invariant/pull/1> (closed **unmerged**;
the branch was deleted).

The branch intentionally weakened `packages/cli/src/verdict/proof.ts`:

```diff
-  return outcome.status === "applied" && outcome.classification === "assertion";
+  return outcome.status === "applied";
```

That makes `harness` and `timeout` failures count as proof, so SELF-004's
decision-table check fails. The workflow run is
<https://github.com/gustavo-oo/invariant/actions/runs/40726506529>:

| Job | Result |
|---|---|
| `invariant-registry` | success |
| `invariant-negative` | success |
| `invariant-checks` | **failure** |
| `invariant-verdict` | **failure** (the required check) |

The `invariant-verdict` job:
<https://github.com/gustavo-oo/invariant/actions/runs/40726506529/job/122951393666>.
The `invariant-checks` job:
<https://github.com/gustavo-oo/invariant/actions/runs/40726506529/job/122951117920>.

The downloaded artifacts pin the cause:

- `checks-result.json` has
  `SELF-004 > counts only an applied, assertion-classified failure as proof`
  with outcome `fail` and an `AssertionError` (`expected [false,false,true,true,true] to deeply equal [false,false,true,false,false]`);
- `invariant-report.json` has `SELF-004: fail`, `self.proof-decision: fail`,
  `exit_code: 1`, `guarantee.class: "G3"` and
  `guarantee.negative_control: "declared-only"`.

So the product rule failed, the gate went red, and the required check was the
one that failed — not an infrastructure-only failure.

## Phase 2 evidence — executed negative control

On 2026-10-28, on branch `phase-2`, the negative control is executed end to end:

```text
npm test            389/389 tests
npm run dogfood     5 rules green, 0 not green, class G3, negative control executed
invariant negative  5/5 checks proven able to fail
```

The dogfood `invariant-report.json` carries
`guarantee.negative_control: "executed"` and every SELF rule has
`sabotage_verified: true`. The `negative-result.json` artifact records
`declared: 5`, `executed: true`, and one
`{ "status": "applied", "classification": "assertion" }` per check.

## Phase 2 evidence — red PRs from the executed control

Both evidence PRs were opened from `phase-2` against `main` and carried the
`invariant:rule-change` label, because `phase-2` also changes `rules/` and
`.invariant/`. Each was closed **unmerged** and its branch deleted after the run
was recorded.

### Red PR 1 — a no-op sabotage is not proof

Demo PR: <https://github.com/gustavo-oo/invariant/pull/3> (closed, unmerged,
branch deleted). Run:
<https://github.com/gustavo-oo/invariant/actions/runs/40796114047>; verdict job:
<https://github.com/gustavo-oo/invariant/actions/runs/40796114047/job/123193086915>.

`.invariant/sabotages/self/check-runner.ts` was replaced with a runner that
reports every check as `not-run`:

```diff
-      checks.map((check) => ({ runtimeId: check.runtimeId, outcome: "pass" })),
+      checks.map((check) => ({
+        runtimeId: check.runtimeId,
+        outcome: "not-run",
+        frameworkId: check.frameworkId,
+      })),
```

SELF-001's check already expects `not-run` to be a failure, so the check stayed
green under sabotage. The control recorded `{ "status": "not-applied" }` for
`self.not-run-fails`:

| Job | Result |
|---|---|
| `invariant-registry` | success |
| `invariant-checks` | success (all 389 tests green; nothing was red about the product) |
| `invariant-negative` | **failure** (4/5 proven, `negative.sabotage_not_applied`) |
| `invariant-verdict` | **failure** (product red, exit 1) |

The downloaded `invariant-report.json` has `exit_code: 1`,
`guarantee.negative_control: "executed"`, `guarantee.class: "G3"`,
`SELF-001: blocked`, `self.not-run-fails: blocked`, and
`sabotage_verified: false` for SELF-001 (true for the other four rules). The PR
comment marked SELF-001 **checked**, not proven, and ends with "No guarantee is
claimed by this run."

### Red PR 2 — a broken sabotage is `harness`, never proof

Demo PR: <https://github.com/gustavo-oo/invariant/pull/4> (closed, unmerged,
branch deleted). Run:
<https://github.com/gustavo-oo/invariant/actions/runs/40796434783>; verdict job:
<https://github.com/gustavo-oo/invariant/actions/runs/40796434783/job/123194096463>.

The same sabotage file was left as invalid TypeScript:

```ts
// @seam-alias packages/cli/src/seams/check-runner.ts
export function createCheckRunner() {
  return {
    run: async (checks) => checks.map((check) => ({ runtimeId: check.runtimeId, outcome: "pass" })
```

The sandbox installs those bytes over the seam and the check cannot load. The
outcome is `{ "status": "applied", "classification": "harness" }` with
`negative.sabotage_harness` ("failed with a harness error under sabotage; that
is not proof"). Jobs: `invariant-registry` success, `invariant-checks` success,
`invariant-negative` **failure** (4/5), `invariant-verdict` **failure** (product
red, exit 1). The report has `SELF-001: blocked`, `sabotage_verified: false`,
`negative_control: "executed"`, class G3; the PR comment reads
`SELF-001 / self.not-run-fails — applied (harness)`.

The class remains **G3** in both runs. An executed negative control in G3 is
evidence, not a binding guarantee. Binding requires G1/G2.

### Workflow finding: a failed token mint must not skip the verdict

The first no-op run
(<https://github.com/gustavo-oo/invariant/actions/runs/40795425726>) never
reached the verdict: "Mint the GitHub App token" failed with
`'Issuer' claim ('iss') must be an Integer`, and GitHub skips the following
steps without `if:` after a failure, so "Aggregate the verdict" never ran. The
job was red for a credential, not for the product.

Commit `3cb4644` sets `continue-on-error: true` on the mint step (the same
treatment "Observe branch protection" already had). A token that cannot be
minted is an unavailable observation: `doctor` reports `observation:
unavailable`, the class stays G3, and `verdict` still runs and fails for its own
reason. The class decision remains in `verdict`; no gate check was weakened.

The `INVARIANT_APP_ID` secret still produces an invalid JWT issuer. Reset it to
the App id (`5514312`, no whitespace or quotes); until then every run reports
the observation as unavailable and stays G3.

### Part B — composite adapters

Part B is covered by the `vue-fastify` fixture: a root Vitest config with
client/server projects, a server seam, a client seam and a Playwright E2E flow
check in one gate. The plugin suite uses a recorded Playwright JSON report; a
real browser run needs `npx playwright install` in the adopter's CI.

## Guarantee class

The `invariant` ruleset (id `26057771`) is currently **disabled** so a solo
maintainer can merge without a second reviewer. The doctor therefore observes
`protection: none` and reports **G3 (procedural)**; the baseline in this PR
records **G3**. G3 is not a guarantee.

The clean-session procedure for separating the agent's identity from the human
reviewer — GitHub App permissions, ruleset activation, the `main` push
allowlist, token minting and the acceptance checks — is in
[the agent identity handoff](agent-identity-handoff.md).

The G1 run `40731664293` and the G1 baseline were captured while the ruleset was
active; they remain evidence, not the current class. The repository standard is
a GitHub App (App `5514312`, installation `176268531`), installed on
`invariant` and `giro-platform-v2`. The two App secrets are configured. Each
workflow mints a token scoped to `github.event.repository.name`; local minting
uses `--repositories <name>`. The private key is installation-wide: if both
repositories share the same App secrets, a compromise of either repository's
Actions can mint tokens for both. Use a separate App for strict isolation.

The legacy `INVARIANT_DOCTOR_TOKEN` PAT secret was removed. To restore G1,
re-enable the ruleset, provide a reviewer (the ruleset requires one approval
plus code-owner review), and run `scripts/enable-g1.sh --record`; merge the
baseline through the rule-change path. The session's `gh` OAuth token was
**not** stored.
