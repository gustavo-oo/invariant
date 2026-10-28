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

The gate is enforced by the active ruleset. The **class is G3 (procedural)**,
not G1: the repository has no `INVARIANT_DOCTOR_TOKEN` secret, so the doctor
cannot observe branch protection and honestly reports `observation:
unavailable`. G3 must never be described as a guarantee.

The environment itself was verified as **G1-capable** with a token held only in
the process environment:

```
observation: available
protection: ruleset
class: G1 (observed)
```

The only missing piece for CI is the repository secret. The optional
`scripts/enable-g1.sh` helper verifies the observation, stores the secret only
when asked, and records the baseline; see
[the adoption guide](adopting.md#optional-raise-the-class-to-g1). The session's
`gh` OAuth token was **not** stored as a repository secret.

To raise the baseline to G1 manually:

1. create a fine-grained PAT with **Administration: read** and **Metadata:
   read** (the default `GITHUB_TOKEN` cannot read rulesets or branch
   protection);
2. store it as the repository secret `INVARIANT_DOCTOR_TOKEN`;
3. run `invariant doctor --record` and commit the resulting
   `.invariant/protection-baseline.json`;
4. confirm `invariant doctor --strict` reports G1 in CI.

The session's `gh` OAuth token was **not** stored as a repository secret.
