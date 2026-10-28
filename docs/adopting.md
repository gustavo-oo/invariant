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

## 3. Give the doctor an App token

The repository standard is a **GitHub App**, not a long-lived personal access
token. Create/install an App with **Administration: read** and **Metadata:
read** (the agent-identity App can be the same one), then store two repository
secrets: `INVARIANT_APP_ID` and `INVARIANT_APP_PRIVATE_KEY`.

The shipped workflow mints a short-lived installation token with
`actions/create-github-app-token` and exposes it to the doctor as
`INVARIANT_DOCTOR_TOKEN`. No PAT is stored. Without the two secrets the token
step is skipped; `doctor` still runs the offline CODEOWNERS and workflow checks,
reports `observation: unavailable`, and lowers the class honestly. In CI the
doctor step is `continue-on-error`; the class decision belongs to
`invariant-verdict`, never to a workflow-level ignore.

Store the two secrets once:

```bash
gh secret set INVARIANT_APP_ID --repo owner/repo --body "<APP_ID>"
gh secret set INVARIANT_APP_PRIVATE_KEY --repo owner/repo \
  < ~/.config/invariant/app.pem
```

One App can be installed on several repositories. The workflow scopes each
token to `github.event.repository.name`; local minting uses
`--repositories <repo-name>`. The private key remains installation-wide: if the
same App (and key) is stored in two repositories, compromising either
repository's Actions secrets can mint tokens for both. Use a separate App per
repository when that blast radius is not acceptable.

For a local run, mint the same token:

```bash
export GH_TOKEN="$(node scripts/github-app-token.mjs \
  --app-id "$INVARIANT_APP_ID" \
  --installation-id "$INVARIANT_APP_INSTALLATION_ID" \
  --repositories invariant \
  --private-key "$HOME/.config/invariant/app.pem")"
export INVARIANT_DOCTOR_TOKEN="$GH_TOKEN"
```

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

## Optional: raise the class to G1

G3 is honest and the ruleset still blocks merges. G1 is stronger because the
doctor has **observed** the protection. This step is optional; do it after the
ruleset is imported and the first green gate run.

1. Ensure the GitHub App from section 3 is installed with **Administration:
   read** and **Metadata: read**, and that `INVARIANT_APP_ID` and
   `INVARIANT_APP_PRIVATE_KEY` are configured. The workflow mints the CI token;
   no PAT secret is required.
2. For a local check, mint a short-lived App token and expose it to the helper:
   ```bash
   export GITHUB_REPOSITORY=owner/repo
   export INVARIANT_DOCTOR_TOKEN="$(node scripts/github-app-token.mjs \
     --app-id "$INVARIANT_APP_ID" \
     --installation-id "$INVARIANT_APP_INSTALLATION_ID" \
     --repositories invariant \
     --private-key "$HOME/.config/invariant/app.pem")"
   ```
3. In this repository, run the optional helper. It verifies the class and
   records the baseline when G1 is observed:
   ```bash
   scripts/enable-g1.sh --check     # verify only; no baseline change
   scripts/enable-g1.sh             # record .invariant/protection-baseline.json
   ```
   If you installed the CLI from npm instead, run the same two commands:
   ```bash
   npx invariant doctor --json --repo "$GITHUB_REPOSITORY" --run-id local
   npx invariant doctor --record
   ```
4. Commit `.invariant/protection-baseline.json` through a pull request. If the
   ruleset already requires a review and you are the only reviewer, temporarily
   disable the ruleset for this bootstrap commit, re-enable it immediately, and
   confirm `invariant doctor --strict` exits `0` with `class: G1`.

The script never creates a token. It refuses to record a baseline unless the
doctor actually observed G1, so a missing permission cannot silently produce a
G1 claim. The CI token is the workflow's short-lived App installation token; no
PAT is stored. This repository currently keeps the ruleset disabled for solo
development, so the honest class is G3; re-enable the ruleset and provide a
reviewer before recording G1. The helper remains ready for that switch.


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

## Agent identity and review separation

If an agent opens pull requests, give it a separate GitHub App identity. The
human stays the only code owner and reviewer; the bot can push feature branches
and open PRs but cannot approve its own work or merge into `main`. The complete
clean-session procedure, including the App permissions, branch-protection
allowlist, token minting and acceptance checks, is in
[the agent identity handoff](agent-identity-handoff.md).

The short version:

- the bot is `<app-slug>[bot]`, with Contents/Pull requests write and
  Administration/Metadata read;
- `@gustavo-oo` remains the only code owner;
- the ruleset requires one approval, code-owner review and `invariant-verdict`,
  with `bypass_actors: []`;
- classic branch protection restricts `main` pushes to the human;
- the clean session uses **only** the App installation token, never a human
  `gh` session;
- the human approves and merges; the bot cannot do either.

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
