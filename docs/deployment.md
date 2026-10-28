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

A real Phase 2 PR with a **no-op** sabotage (red `blocked`) and a broken
sabotage (red `harness`) is still pending; the Phase 1 red PR above proves the
aggregate check, not the executed control. The class remains **G3**; an executed
negative control in G3 is evidence, not a binding guarantee. Binding requires
G1/G2.

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
