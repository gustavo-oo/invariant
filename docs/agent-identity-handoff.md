# Agent identity and review separation — handoff

This is the clean-session handoff for giving the coding agent a **separate
GitHub identity**, so it can open pull requests while only the human can approve
and merge them. It also records the current deployment state and the exact
checks that prove the separation.

## Current state

- Public repository: <https://github.com/gustavo-oo/invariant>.
- `main` includes the deployment record, the G1 helper and the G3 baseline.
  Use `git log -1` for the exact commit; PR #2 was merged as `cf6d448`.
- Ruleset `invariant` (id `26057771`) is **disabled** on purpose: the repository
  currently has one human maintainer, and the ruleset requires an independent
  reviewer. The honest class is **G3 (procedural)**.
- `.invariant/protection-baseline.json` records `recorded_class: G3`.
- `INVARIANT_DOCTOR_TOKEN` is configured as a repository secret (fine-grained
  PAT with **Administration: read** and **Metadata: read**). The secret value is
  not readable after it is stored.
- The G1 evidence is preserved in `docs/deployment.md`: run `40731664293` passed
  with `class G1` while the ruleset was active. It is evidence, not the current
  class.
- This session's `gh` can see the human accounts `gustavo-oo` and `juliababa`.
  **Do not reuse those credentials in the clean session.** A GitHub App bot must
  be the only identity that can act on the repository from the agent's shell.

## Why a separate identity

GitHub decides self-approval by account, not by process. If the agent uses the
human's token, the PR author is the human and GitHub rejects the human's
approval. An agent that can `gh auth switch` to the human has not been separated
at all.

The target split:

| Actor | Identity | May do | Must not do |
|---|---|---|---|
| Human owner | `gustavo-oo` | review, approve, merge, change settings | hand its token to the agent |
| Agent | `<app-slug>[bot]` | create branches, push feature branches, open/update PRs | approve its own PR, push/merge `main`, change rulesets, be a code owner |
| CI | GitHub Actions (`15368`) | run `invariant-verdict` | approve or merge |

## Clean-session prerequisites

- A clean shell with **no human `GH_TOKEN`** exported. `gh auth status` may list
  human accounts from the keyring; do not use them.
- The App's private key stored outside the repository, for example
  `~/.config/invariant/app.pem` with mode `600`.
- The App id and installation id (not secrets).
- A checkout of `main` and a passing `npm test`.

## Step 1 — create the GitHub App (human, browser)

1. GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Name it `invariant-agent`; homepage can be the repository URL. Disable the
   webhook (the integration does not need one).
3. Repository permissions:
   - **Contents:** Read and write (create branches and commits)
   - **Pull requests:** Read and write
   - **Metadata:** Read-only
   - **Administration:** Read-only (the doctor needs to observe rulesets)
   - Leave **Workflows**, **Actions**, **Checks** and **Issues** unset unless a
     concrete workflow requires them. The bot must not change
     `.github/workflows/invariant.yml`; that is a human decision.
4. “Where can this GitHub App be installed?”: only this account.
5. Create the App; note the **App ID**. Generate a **private key** and save it
   as `~/.config/invariant/app.pem` (`chmod 600`). Never commit it.
6. Install the App on `gustavo-oo/invariant`; note the **installation ID**.

The App is free for a public repository. It does not consume a seat.

## Step 2 — keep the human as the only code owner

`.github/CODEOWNERS` must keep `@gustavo-oo` as the owner of `rules/`,
`.invariant/`, the workflow and CODEOWNERS itself. Do **not** add the bot: a bot
cannot review as a code owner, and adding it would let the bot satisfy its own
review requirement.

If you use a second human account as the reviewer, add that account to
CODEOWNERS instead; the agent still must not have its token.

## Step 3 — re-enable the ruleset

The ruleset source of truth is `.invariant/protection.ruleset.json`; it has
`enforcement: active`. Re-apply it after the App is installed:

```bash
gh api --method PUT repos/gustavo-oo/invariant/rulesets/26057771 \
  --input .invariant/protection.ruleset.json
gh api repos/gustavo-oo/invariant/rulesets/26057771 \
  --jq '{enforcement, bypass_actors, rules: [.rules[].type]}'
```

Expected: `enforcement: active`, `bypass_actors: []`, required check
`invariant-verdict` pinned to app `15368`, one required approval, code-owner
review and stale-review dismissal.

The `bypass_actors` list must stay empty. A bot added as a bypass actor would
make the doctor lower the class and would recreate the self-merge problem.

## Step 4 — restrict pushes to `main` to the human

The ruleset requires a PR and an approval, but a write-capable bot could still
merge after the human approves. Add a classic branch protection rule for `main`:

1. **Settings → Branches → Add branch protection rule** for `main`.
2. Enable **Restrict who can push to matching branches**.
3. Add only `gustavo-oo` (and any second human reviewer). Do **not** add the App.
4. Keep the ruleset active; it supplies the required check and code-owner gate.

Use classic branch protection for this allowlist, not a ruleset bypass actor:
the doctor reads ruleset bypass actors, and the G1 baseline must keep that list
empty. The human's UI merge is a human push and remains allowed; the bot's merge
or direct push is rejected.

## Step 5 — mint the bot token in the clean session

The helper uses only Node built-ins:

```bash
node scripts/github-app-token.mjs --jwt-only \
  --app-id <APP_ID> \
  --private-key ~/.config/invariant/app.pem   # offline signing test
```

Then mint an installation token and export it only for this shell session:

```bash
export GH_TOKEN="$(node scripts/github-app-token.mjs \
  --app-id <APP_ID> \
  --installation-id <INSTALLATION_ID> \
  --private-key ~/.config/invariant/app.pem)"
gh api user --jq .login      # must print <app-slug>[bot]
```

The token expires after about one hour; mint a new one for each session. Never
write it to a file in the repository. For `git push`, use an askpass script so
the token is not embedded in the remote URL:

```bash
export GIT_ASKPASS="$TMPDIR/invariant-askpass.sh"
printf '#!/bin/sh\nprintf "%%s\\n" "$GH_TOKEN"\n' > "$GIT_ASKPASS"
chmod +x "$GIT_ASKPASS"
git push https://x-access-token@github.com/gustavo-oo/invariant.git \
  HEAD:refs/heads/<branch>
```

Do not run `gh auth login`, `gh auth switch` or any command that puts a human
token in this shell. `GH_TOKEN` takes precedence in `gh`, but `git` uses the
askpass script; both must be the bot.

## Step 6 — prove the separation with a throwaway PR

1. Create a branch and a **non-protected** file (for example
   `docs/agent-smoke.md`), commit, push with the bot token.
2. Open a PR with `gh pr create`. Confirm the author:

   ```bash
   gh pr view <n> --json author,url
   ```

   The author must be `<app-slug>[bot]`, not `gustavo-oo`.
3. Confirm the bot cannot approve its own PR:

   ```bash
   gh pr review <n> --approve
   ```

   Expect `HTTP 422`/“Can not approve your own pull request”.
4. Confirm `invariant-verdict` runs on the bot PR. The branch is in the same
   repository, so Actions can read `INVARIANT_DOCTOR_TOKEN`.
5. Confirm the bot cannot push to `main`:

   ```bash
   git push https://x-access-token@github.com/gustavo-oo/invariant.git \
     HEAD:main
   ```

   Expect a rejection from the ruleset/branch protection.
6. Approve and merge a real change only from the human UI. Then close the
   throwaway PR and delete its branch.

## Step 7 — record G1 with the new identity

The ruleset must be active and the bot must be unable to approve itself. Use a
token that can read rulesets:

- the App token, if the App has **Administration: read**; or
- the fine-grained PAT already stored as the repository secret.

```bash
export GITHUB_REPOSITORY=gustavo-oo/invariant
export INVARIANT_DOCTOR_TOKEN="<token with Administration: read>"
scripts/enable-g1.sh --check     # must print class G1
scripts/enable-g1.sh --record    # writes recorded_class: G1
```

Then commit `.invariant/protection-baseline.json` on a bot branch and open a PR.
Because `.invariant/` is protected, the PR needs the `invariant:rule-change`
label. If the App does not have Issues permission, the human adds the label;
the human also supplies the required code-owner approval. Merge only from the
human UI.

After merge, confirm on `main`:

```bash
INVARIANT_DOCTOR_TOKEN=... node packages/cli/dist/cli.js doctor --strict \
  --repo gustavo-oo/invariant --run-id local
# class: G1 (observed), exit 0
```

## Acceptance checklist

- [ ] Clean shell has only the App installation token; `gh api user` is the bot.
- [ ] Ruleset active; required check `invariant-verdict`; `bypass_actors: []`.
- [ ] CODEOWNERS lists only the human reviewer(s).
- [ ] Classic branch protection restricts `main` pushes to the human.
- [ ] Bot PR author is the bot; the bot gets 422 when approving its own PR.
- [ ] Human approval is required; the human merges from the UI.
- [ ] Bot direct push to `main` is rejected.
- [ ] `invariant-verdict` runs on bot PRs and can read the secret.
- [ ] G1 baseline recorded through a reviewed rule-change PR; `doctor --strict`
      reports G1.
- [ ] No human token is present in the clean session.

## Rollback

1. Disable the ruleset:
   `gh api --method PUT repos/gustavo-oo/invariant/rulesets/26057771 --input <disabled-json>`
   (set `enforcement: "disabled"`), or use the GitHub UI.
2. Remove the “Restrict who can push” branch protection rule for `main`.
3. Uninstall the GitHub App; delete its private key.
4. Restore `.invariant/protection-baseline.json` to `recorded_class: G3`.
5. Close bot PRs and delete bot branches.
6. Record the reason in `docs/deployment.md`; the class returns to G3.

## Handoff prompt for the clean session

Paste this into the new session, then answer the browser-only questions:

```text
You are continuing the invariant project in a clean session. Read
docs/agent-identity-handoff.md before acting.

Current state: public repo gustavo-oo/invariant; main has the deployment record
and a G3 baseline; ruleset 26057771 is disabled; INVARIANT_DOCTOR_TOKEN is set;
PR #2 was merged; the G1 evidence is run 40731664293. The current session's
human gh accounts are not to be used.

Goal: give the agent a separate GitHub App identity, keep the human as the only
code owner/reviewer, re-enable the ruleset with no bypass actors, restrict main
pushes to the human, prove the bot cannot approve or merge its own PR, then
record a G1 baseline through a reviewed rule-change PR.

Use only GH_TOKEN minted by scripts/github-app-token.mjs. Never run
gh auth login/switch to a human account. The human performs all browser-only
steps: creating/installing the App, adding the branch-protection allowlist,
approving PRs and merging. Do not store the App private key or any token in the
repository.

Start with git status and npm test. Then follow Steps 5–7. Stop and ask the human
for the App id, installation id and private-key path before minting the token.
Report the author of the smoke PR, the 422 from self-approval, the rejected
direct push to main, and the final doctor --strict class.
```
