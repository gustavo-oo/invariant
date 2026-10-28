# Adopting invariant

This guide takes a repository from no gate to `invariant-verdict` requiring a
green rule check on every pull request. It assumes Node ≥20 and a GitHub
repository.

> **What you get today:** Phase 0 + Phase 1. The registry, tagged checks,
> execution, verdicts, reports and the CI workflow are real. The sabotaged run
> that proves a rule can fail is Phase 2; until then the report says
> `negative_control: "declared-only"` and every rule says
> `sabotage_verified: false`. Never describe a rule as proven or guaranteed.

## 1. Install and bootstrap

```bash
npm install --save-dev invariant
npx invariant init . --owner @your-handle
```

`init` writes:

- `rules/example.yaml` and `rules/flows/example-request.yaml` — a walking
  skeleton: one enforced rule, one critical flow, one seam and one declared
  sabotage;
- `invariant-example/` — a tiny limiter, its tagged test and a README;
- `.invariant/config.yaml`, `.invariant/protection.ruleset.json` and
  `.invariant/protection-baseline.json`;
- `.github/workflows/invariant.yml`, rendered for your repository;
- an appended `# >>> invariant >>>` block in `.github/CODEOWNERS`.

It never overwrites an existing file and never appends the CODEOWNERS block
twice. Run `npx invariant verify` once: the walking skeleton must be green.
Then delete or replace the skeleton (`rules/example.yaml`,
`rules/flows/example-request.yaml` and `invariant-example/`) as you add your
real rules.

## 2. Import the protection ruleset

The generated `.invariant/protection.ruleset.json` requires
`invariant-verdict` on the default branch, requires code-owner review and
forbids non-fast-forward pushes. Import it with a token that can administer
rulesets:

```bash
gh api --method POST repos/:owner/:repo/rulesets \
  --input .invariant/protection.ruleset.json
```

Confirm in the repository settings (or with
`gh api repos/:owner/:repo/rulesets`) that:

- the required check is exactly `invariant-verdict`;
- it is pinned to the GitHub Actions app (`github-actions`, app id `15368` by
  default, matching `doctor.expectedAppId`);
- the bypass list is empty;
- “Do not allow bypassing the above settings” is on.

GitHub reports a check from a reusable workflow as
`<caller job> / <called job>`. This repository ships a plain
`invariant-verdict` job, so the context is exactly `invariant-verdict`. If you
embed the workflow through `workflow_call`, record the exact context in
`.invariant/protection-baseline.json` (`expected.required_context`) so `doctor`
verifies the name branch protection actually requires (PEND-5).

## 3. Give the doctor an observation token

`doctor` needs a fine-grained personal access token with **Administration:
read** and **Metadata: read**. The default `GITHUB_TOKEN` cannot read rulesets
or branch protection. Store it as the repository secret
`INVARIANT_DOCTOR_TOKEN`.

The token is optional: without it, `doctor` still runs the offline CODEOWNERS
and workflow checks, reports `observation: unavailable`, and lowers the class
honestly. In CI the workflow marks the doctor step `continue-on-error`; the
class decision belongs to `invariant-verdict`, never to a workflow-level
ignore.

## 4. Require code owners for the protected paths

`.github/CODEOWNERS` must cover:

- `rules/`
- `.invariant/`
- `.github/workflows/invariant.yml`
- `.github/CODEOWNERS` itself

The `invariant init` block already does this for your owner. Enable “Require
review from Code Owners” in the branch protection/ruleset. `doctor` checks the
file's syntax and coverage; a line GitHub would silently skip is a **fail**
finding, because the owner would never be requested.

Rule changes must go through the flagged path: a protected-path change in a
feature PR is red unless the PR carries the `invariant:rule-change` label
(`.invariant/config.yaml: ruleChange.label`).

## 5. Record the class you actually have

Run the doctor, inspect its output, then record the baseline:

```bash
npx invariant doctor --json --out invariant-doctor.json --repo owner/repo --run-id 1
npx invariant doctor --record
```

`--record` writes the observed class, the required context/app and the observed
bypass list to `.invariant/protection-baseline.json`. A fresh `init` records
**G3** until the gate has run and the ruleset is imported; `doctor --record`
after that is the explicit step that raises it. `invariant verdict` reads the
baseline and fails closed if the environment gets weaker.

Use `doctor --strict` if you want a human-facing command to exit `1` whenever
the class is below G1. In CI, `invariant-verdict` is the gate; the workflow
never interprets the doctor's exit code.

## 6. Wire the gate

The generated workflow runs four jobs:

| Job | Purpose |
|---|---|
| `invariant-registry` | schema, links, integrity and the immutability diff |
| `invariant-checks` | discover and execute the tagged checks (or read reports) |
| `invariant-negative` | validate the declared sabotage files (`@seam-alias`, target) |
| `invariant-verdict` | the single required check; aggregates the three artifacts and the class |

Requiring exactly `invariant-verdict` keeps the gate stable when individual
jobs are renamed. Upstream missing/cancelled/skipped artifacts are gate
failures; absence is never success.

## 7. The dependency-injection requirement

Every enforced rule must be able to fail under a sabotaged run. That requires
your rule-bearing behaviour to receive its collaborators by injection:

- a composition root at the application edge;
- module boundaries for pure logic;
- a module the sabotage can alias for the duration of a run.

If a rule cannot be sabotaged yet, keep it `draft` and record it as work. A
declared sabotage without a seam is not proof; the registry validator and
`invariant negative` reject an incomplete declaration, and the rule is never
reported as proven. Phase 2 adds the isolated sabotaged run and the
`assertion`/`harness`/`timeout` classification; until then, the honest status is
**checked and green**, never guaranteed.

## 8. Verify the installation

```bash
npx invariant validate
npx invariant verify
npx invariant negative
npx invariant doctor --json
```

Then open a pull request that changes a rule without the
`invariant:rule-change` label: `invariant-verdict` must be red. Change a check's
code so it fails: `invariant-verdict` must be red. Break the registry (an
enforced rule with no checks): the gate must be `2`, not a product verdict.
The corpus in `packages/cli/test/integration/corpus.test.ts` pins each of these
behaviours for the plugin itself.
