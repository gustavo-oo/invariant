# invariant

`invariant` verifies the rules declared under `rules/**` against tests tagged in
your project's own test framework. It is a forge-neutral CLI (Node ≥20): the
registry is plain files and the single source of truth, checks are ordinary
tests, and a thin adapter turns discovery and test results into per-rule and
per-flow verdicts. It writes `invariant-report.json` and a PR comment, and exits
`0`/`1`/`2`. It discovers, runs, maps, verifies and reports — it never owns your
tests, your test config or your data.

> **Scope of this delivery:** Phase 2, Parts A + B. The negative control is
> executed: every enforced check runs again in an isolated copy with its
> declared seam sabotaged, and a rule is `proven` only when that run failed with
> an `assertion`-classified failure. Multiple adapters can share one gate:
> Vitest for client/server and Playwright for E2E. The guarantee is binding only
> at G1/G2; this repository is honestly **G3 (procedural)**.

## Guarantee status

The mechanism of spec §7 is implemented. `invariant negative` and `invariant
verify` execute each declared sabotage in a disposable sandbox; the report
carries `negative_control: "executed"` and `sabotage_verified` is true only when
**every** check of the rule failed by assertion under its sabotage. A no-op, a
harness error or a timeout is `blocked` and red — a false red, never a false
green.

| Delivered in Phase 2 | Not delivered here |
|---|---|
| `Adapter.applySabotage` + `classifyFailure`; isolated-copy runs with a sanitized env | `invariant-scope` |
| Real `SabotageOutcome` producers; `blocked` verdicts | `invariant status` (draft backlog / missing-seam queue) |
| `negative_control: "executed"`; `sabotage_verified` only with proof | Agent skill (`skill.distribution`) |
| `no-op` / `harness` / `timeout` detection (false red, never false green) | Change-detection caching for the negative job |
| JUnit XML fallback for existing reports | — |
| Composite `adapters: [vitest, playwright]`; Playwright E2E | — |
| Scheduled full run and `--base ""` as “no diff” | — |

Consequences that must not be papered over anywhere in code, docs, PR comments
or commit messages:

1. A rule is *proven* only when every check failed under its declared sabotage
   with an `assertion`-classified failure. Every other outcome is `blocked`.
2. G3 is procedural. An executed negative control in a G3 run is evidence, not a
   guarantee; the class and the below-G1 warning stay in the report and the PR
   comment.
3. The sandbox excludes known secrets and blocks non-loopback network
   best-effort; OS-level isolation is not claimed. The seam module is replaced
   wholesale, so its relative imports resolve from the target's directory.
4. `invariant-scope`, `invariant status` and the agent skill are later work,
   not weaker versions of this guarantee.

## How the gate works

1. **Declare a rule** in `rules/<capability>.yaml` with an id, statement,
   rationale, criticality, status and checks. An `enforced` rule needs owners,
   at least one check, and a declared seam sabotage on every check.
2. **Tag a test** in your own framework with the check, rule and flow it
   implements. The registry is authoritative; a tag that does not resolve is an
   integrity failure, never a silent match.
3. **Run the stages** — `invariant verify` loads and validates the registry,
   discovers checks, reconciles integrity, checks immutability, executes (or
   reads a report), **runs the declared sabotage in an isolated copy**, rolls
   the verdict up to rules and flows, and publishes the report and comment.
4. **The gate** is red (`1`) when an enforced rule or a flow is not green. An
   invalid registry, broken discovery/integrity, an unreadable event/diff or a
   run that cannot execute is a gate failure (`2`), never a product verdict.
   `not-run` and `flaky` are never green.

The full pipeline is `rule → tagged check → execution → check verdict → rule
verdict → flow verdict → exit code + report + comment`.

## Dependency injection is the seam

The negative control works through **injected seams**. Rule-bearing behaviour
must receive its collaborators by injection: a composition root at the
application edge, module boundaries for pure logic, and the ability to alias a
module for the duration of a sabotaged run. If a rule cannot be sabotaged yet,
it stays `draft`; it is never described as enforced, proven or green.

Every declared sabotage names its seam with `@seam-alias <repo-relative path>`.
The sabotaged run copies the repository, replaces that module's bytes with the
sabotage file, and runs the check there. It does not patch production code.

## CLI

```
invariant validate  [--root <dir>] [--base <ref>] [--event <path>] [--json] [--out <file>]
invariant run       [--root <dir>] [--adapter <id>]... [--reports <file>]... [--json] [--out <file>]
invariant negative  [--root <dir>] [--adapter <id>]... [--json] [--out <file>]
invariant verdict   --inputs <dir> [--job-status <job>=<result>]... [--doctor-result <file>]
                    [--repo <owner/name>] [--run-id <id>] [--baseline <file>]
                    [--root <dir>] [--out <file>] [--comment <file>] [--base <ref>] [--head <sha>]
invariant verify    [--root <dir>] [--adapter <id>]... [--base <ref>] [--head <sha>] [--event <path>]
                    [--reports <file>]... [--doctor-result <file>] [--repo <owner/name>]
                    [--run-id <id>] [--baseline <file>] [--out <file>] [--comment <file>] [--json]
invariant doctor    [--root <dir>] [--record] [--strict] [--check <name>] [--json] [--out <file>]
invariant init      [dir] --owner <@handle> [--adapter <id>] [--cli-setup <cmd>] [--invariant-cmd <cmd>]
```

Repeat `--adapter` to run a mixed gate. `--reports <adapter>=<file>` routes a
report to one adapter; an unprefixed path is offered to every adapter.

## Exit codes

| Code | Meaning | Reaction |
|---|---|---|
| `0` | All enforced rules and flows are green | Merge may proceed |
| `1` | An enforced rule or a flow is not green, or a protected path changed outside the flagged path | The product or rule is wrong; fix it through the rule-change path |
| `2` | Registry/config invalid, adapter failed, integrity broken, or the verifier could not run | The gate is wrong; never merge on this |

## Guarantee classes

| Class | Mechanism | Where it is available |
|---|---|---|
| **G1 — mechanical** | Required status check blocks merge; protected paths + code-owner review; the check is pinned to the expected App source; bypass disabled for admins | Public repo on Free, or GitHub Pro/Team on private |
| **G2 — credential** | The agent's identity cannot write to `main` or the protected paths (GitHub App token, fork-based flow, human-only merge). The forge is not relied upon | Any plan, any visibility |
| **G3 — procedural** | The verdict is visible on the PR and a human acts on it. Weakest class; **must never be described as a guarantee** | Any plan, any visibility |

`invariant doctor` observes the forge and reports the class actually in force.
A missing observation, a missing required check, a weak or unpinned check, a
missing code-owner rule or a growing bypass list lowers the class; it is never
silently ignored. Record the observed environment with
`invariant doctor --record`; `verdict` gates a regression against that baseline.
For the optional step that raises the class from G3 to G1, see
[the adoption guide](docs/adopting.md#optional-raise-the-class-to-g1).

## Live instance

The public dogfood repository is <https://github.com/gustavo-oo/invariant>. Its
[deployment record](docs/deployment.md) includes the imported protection
ruleset, the red-PR evidence and the G1 helper. The ruleset is currently
**disabled** so a solo maintainer can merge without a second reviewer; the
honest class is **G3 (procedural)**.

The executed negative control is evidenced locally:

```text
npm test            389/389
npm run dogfood     5 rules green, 0 not green, class G3, negative control executed
invariant negative  5/5 checks proven able to fail
```

G3 is not a guarantee; a proven rule in a G3 run is evidence, not a binding
gate. The [agent identity handoff](docs/agent-identity-handoff.md) documents
how to move the agent to a separate GitHub App identity, restore the reviewer
gate and record G1.

## Development

```bash
npm install
npm test          # build + the CLI's full test suite
npm run dogfood   # run invariant against this repository's own SELF rules
```

Read the [design spec](docs/superpowers/specs/2026-10-17-invariant-design.md) and
the [Phase 0 + Phase 1 plan](docs/superpowers/plans/2026-10-17-invariant-phase-0-1.md)
for the delivered baseline, and the
[Phase 2 plan](docs/superpowers/plans/2026-10-28-invariant-phase-2.md) for the
executed negative control and the Vue 3 + Fastify adoption slice.
