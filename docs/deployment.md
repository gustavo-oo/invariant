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
a GitHub App: configure `INVARIANT_APP_ID` and `INVARIANT_APP_PRIVATE_KEY`, and
the workflow mints the doctor token with `actions/create-github-app-token`. The
legacy `INVARIANT_DOCTOR_TOKEN` PAT secret was removed. To restore G1, set the
App secrets, re-enable the ruleset, provide a second reviewer (the ruleset
requires one approval plus code-owner review), and run
`scripts/enable-g1.sh --record`; merge the baseline through the rule-change
path. The session's `gh` OAuth token was **not** stored.
