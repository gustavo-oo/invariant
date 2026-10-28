# invariant

`invariant` verifies the rules declared under `rules/**` against tests tagged in
your project's own test framework. It is a forge-neutral CLI (Node ≥20): the
registry is plain files and the single source of truth, checks are ordinary
tests, and a thin adapter turns discovery and test results into per-rule and
per-flow verdicts. It writes `invariant-report.json` and a PR comment, and exits
`0`/`1`/`2`. It discovers, runs, maps, verifies and reports — it never owns your
tests, your test config or your data.

> **Scope of this delivery:** Phase 0 + Phase 1. The complete guarantee of spec
> §7 does not exist until Phase 2; this plan delivers the registry, discovery,
> execution, verdicts, reports, CI workflow, `doctor` and `init`.

## Guarantee status: what this delivery does **not** deliver

State this at the top of any announcement about this work, and repeat it in the
PR comment the tool produces.

**The complete guarantee of spec §7 does not exist until Phase 2. This plan
delivers Phase 0 + Phase 1.**

| Delivered here | Not delivered here (Phase 2) |
|---|---|
| Registry schema + validator; `enforced` requires owners, ≥1 check, and a declared `seam` negative control with a declared sabotage **on every check** (spec §5.1) | Running the sabotaged check and classifying its failure |
| Discovery of tagged checks; adapter interface; TypeScript/Vitest reference adapter | `Adapter.applySabotage` / `Adapter.classifyFailure` |
| `not-run` / `flaky` are never green (`not-run` is a positive-control rule; `flaky` comes from read reports) | Producing `blocked` verdicts from a missing/unappliable seam |
| Verdict roll-up for rules and flows, exit codes, reports carrying the guarantee class | `invariant status`, `invariant-scope`, PR-comment polish, the agent skill (Phase 3) |
| The **decision table** that decides whether a sabotage outcome counts as proof (`src/verdict/proof.ts`), unit-tested | Any *producer* of sabotage outcomes other than the test harness |
| `invariant doctor`, baseline-based regression detection, class computation | — |
| Implicit immutability diff (spec §8 stage 4) and fail-closed aggregation of upstream jobs | — |

Consequences that must not be papered over anywhere in code, docs, PR comments
or commit messages:

1. The report carries `guarantee.negative_control: "declared-only"` and every
   rule carries `sabotage_verified: false`. **No output may say a rule is
   proven, verified-able-to-fail, or guaranteed.** A rule is at most *checked
   and green*.
2. The PR comment prints a banner saying the full guarantee is not in force in
   this delivery.
3. `invariant negative` validates *declarations* (`@seam-alias` present, sabotage
   file exists) and prints the not-executed notice. It must not report the
   negative control as executed or pass.
4. Phase 2 is a separate plan. It adds an implementation of `applySabotage` +
   `classifyFailure` and a real producer for `SabotageOutcome`; it does not
   change the registry schema, the verdict vocabulary or the report shape.

## How the gate works

1. **Declare a rule** in `rules/<capability>.yaml` with an id, statement,
   rationale, criticality, status and checks. An `enforced` rule needs owners,
   at least one check, and a declared seam sabotage on every check.
2. **Tag a test** in your own framework with the check, rule and flow it
   implements. The registry is authoritative; a tag that does not resolve is an
   integrity failure, never a silent match.
3. **Run the stages** — `invariant verify` loads and validates the registry,
   discovers checks, reconciles integrity, checks immutability, executes (or
   reads a report), records the declared-only negative control, rolls the
   verdict up to rules and flows, and publishes the report and comment.
4. **The gate** is red (`1`) when an enforced rule or a flow is not green. An
   invalid registry, broken discovery/integrity, an unreadable event/diff or a
   run that cannot execute is a gate failure (`2`), never a product verdict.
   `not-run` and `flaky` are never green.

The full pipeline is `rule → tagged check → execution → check verdict → rule
verdict → flow verdict → exit code + report + comment`.

## Dependency injection is the seam

The Phase 2 negative control only works through **injected seams**. Rule-bearing
behaviour must receive its collaborators by injection: a composition root at the
application edge, module boundaries for pure logic, and the ability to alias a
module for the duration of a sabotaged run. If a rule cannot be sabotaged yet,
it stays `draft`; it is never described as enforced, proven or green.

Every declared sabotage names its seam with `@seam-alias <repo-relative path>`.
This delivery validates the declaration; it does not apply it.

## CLI

```
invariant validate  [--root <dir>] [--base <ref>] [--event <path>] [--json] [--out <file>]
invariant run       [--root <dir>] [--adapter <id>] [--reports <file>]... [--json] [--out <file>]
invariant negative  [--root <dir>] [--json] [--out <file>]
invariant verdict   --inputs <dir> [--job-status <job>=<result>]... [--doctor-result <file>]
                    [--repo <owner/name>] [--run-id <id>] [--baseline <file>]
                    [--root <dir>] [--out <file>] [--comment <file>] [--base <ref>] [--head <sha>]
invariant verify    [--root <dir>] [--adapter <id>] [--base <ref>] [--head <sha>] [--event <path>]
                    [--reports <file>]... [--doctor-result <file>] [--repo <owner/name>]
                    [--run-id <id>] [--baseline <file>] [--out <file>] [--comment <file>] [--json]
invariant doctor    [--root <dir>] [--record] [--strict] [--check <name>] [--json] [--out <file>]
invariant init      [dir] --owner <@handle> [--adapter <id>] [--cli-setup <cmd>] [--invariant-cmd <cmd>]
```

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
| **G2 — credential** | The agent's identity cannot write to `main` or the protected paths (fine-grained token, fork-based flow, human-only merge). The forge is not relied upon | Any plan, any visibility |
| **G3 — procedural** | The verdict is visible on the PR and a human acts on it. Weakest class; **must never be described as a guarantee** | Any plan, any visibility |

`invariant doctor` observes the forge and reports the class actually in force.
A missing observation, a missing required check, a weak or unpinned check, a
missing code-owner rule or a growing bypass list lowers the class; it is never
silently ignored. Record the observed environment with
`invariant doctor --record`; `verdict` gates a regression against that baseline.

## Development

```bash
npm install
npm test          # build + the CLI's full test suite
npm run dogfood   # run invariant against this repository's own SELF rules
```

Read the [design spec](docs/superpowers/specs/2026-10-17-invariant-design.md) and
the [implementation plan](docs/superpowers/plans/2026-10-17-invariant-phase-0-1.md)
for the full rationale, the Phase 2 boundary and the review focus.
