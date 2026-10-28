# invariant — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the declared negative control into an executed one. Every `enforced` rule's checks run a second time in an isolated copy with the declared seam module replaced by its sabotage; the failure is classified; and a rule is green only when every one of its checks failed with an `assertion`-classified failure. Deliver real `blocked` verdicts, `negative_control: "executed"`, `sabotage_verified: true` only with proof, and the Vue 3 + Fastify adoption slice (Vitest client/server plus Playwright E2E).

**Architecture:** Phase 1 built every collaborator behind a seam in `src/seams/` and fixed the decision table in `src/verdict/proof.ts`. Phase 2 adds the missing producer: a **negative-control executor** that, for each enforced check, copies the repo to a disposable sandbox, replaces the module named by the sabotage's `@seam-alias` with the sabotage file, runs the check with the adapter's own runner, classifies the failure as `assertion` / `harness` / `timeout`, and returns one `SabotageOutcome` per check id. The verdict engine already knows how to turn an outcome into `sabotage_verified`; Phase 2 makes `pass` + non-proof become `blocked`, and makes a missing/unexecuted negative stage a **gate** failure (exit 2), never a silent `declared-only` green. Part B adds a composite adapter pipeline and a Playwright adapter for real E2E; it does not change the registry schema, the verdict vocabulary or the report shape.

**Tech Stack:** TypeScript (compiled with `tsc` to ESM), Node ≥20, Vitest 3 (the CLI's own tests and the reference adapter), `yaml`, `ajv`, `typescript`. No new runtime dependencies; the JUnit fallback is a hand-written parser for the JUnit subset. Part B adds no runtime dependency either: the Playwright adapter drives the project's own `@playwright/test`.

**Spec:** `docs/superpowers/specs/2026-10-17-invariant-design.md` (§6, §7, §8, §11, §12, §14). Phase 2 is `Seam sabotage runs, failure classification, blocked verdicts`; Phase 3 remains `invariant-scope`, `invariant status`, PR-comment polish and the agent skill.

---

## Delivery status

**Part A delivers the complete guarantee of spec §7.** A rule is *proven* only when every one of its checks failed under its declared seam sabotage with an `assertion`-classified failure. A `harness`, `timeout`, `not-applied` or `not-executed` outcome is **not proof**; the rule is `blocked` and the gate is red (exit 1). If the negative stage cannot run at all, the gate is broken (exit 2), never green.

**Part B is the Vue 3 + Fastify adoption slice.** It is an extension, not a condition for §7: multiple adapters in one gate, a Playwright adapter for real browser E2E, and the stack documentation. It can land after Part A without changing any Part A contract.

**The guarantee is still conditional on the class.** G1 is mechanical, G2 is credential-based, G3 is procedural. A proven rule in a G3 run is still not a guarantee; the report and the PR comment must keep saying so.

| Delivered here | Not delivered here (Phase 3) |
|---|---|
| `Adapter.applySabotage` + `Adapter.classifyFailure`; `SabotageSpec` | `invariant-scope` |
| Isolated-copy sabotaged runs with a sanitized environment | `invariant status` (draft backlog / missing seam queue) |
| `SabotageOutcome` producers; real `blocked` verdicts | PR-comment polish beyond proof/checked |
| `negative_control: "executed"`; `sabotage_verified` only with proof | Agent skill (`skill.distribution`) |
| `no-op` / `not-applied` detection (false red, never false green) | Change-detection caching for the negative job |
| JUnit XML fallback for existing reports | `invariant-scope` advisory/blocking rollout |
| Scheduled full run | — |
| Part B: multiple adapters, Playwright E2E, Vue+Fastify guide | — |

## What changes on every surface

| Surface | Phase 0/1 today | Phase 2 |
|---|---|---|
| `Adapter` | `id`, `discover`, `run`, `readReports` | `+ applySabotage`, `+ classifyFailure` |
| `RunOpts.env` | merged over `process.env` | **replaces** the environment when supplied |
| `negative-result.json` | `{declared, executed: false, findings}` | `{declared, executed, outcomes, findings}` |
| `invariant negative` | validates declarations, prints declared-only | executes every declared sabotage, prints `executed — N/M proven` |
| `verify` stage 6 | no producer; every check `not-executed` | executes the negative control in isolated copies |
| Check verdict | `pass` from a green test | `blocked` when a green test is not proven |
| Report | `negative_control: "declared-only"`, all `sabotage_verified: false` | `"executed"`; `sabotage_verified` true only with proof |
| PR comment | declared-only banner | `proven` / `checked`, per-check negative-control reasons |
| `verdict` | trusts the negative artifact's `executed` flag but has no outcomes | fail-closed on missing outcomes; product red for non-proof; a failed negative job is read, not treated as a gate error |
| Workflow | negative job validates files | negative job runs in parallel; scheduled full run |
| Dogfood | five declared sabotages | five **executed** sabotages; SELF-004 retargeted |

## Residual limits (say these plainly)

1. **Network isolation is best-effort.** The sabotaged run gets an isolated copy, a sanitized environment and a Node preload that blocks non-loopback sockets; Node cannot promise OS-level network isolation on every platform. The guarantee is that the run *needs* no secrets and no external network, not that a hostile test cannot escape a process sandbox.
2. **The seam module is replaced wholesale.** The sabotage file is written over the `@seam-alias` target in the copy. Its relative imports therefore resolve from the target's directory, not from `.invariant/sabotages/`. A seam module with unrelated exports needs a sabotage that re-exports them, or the module should be split.
3. **Every gate runs all sabotages.** Change-detection caching is deliberately deferred; the scheduled full run covers drift and the PR job is the expensive one. This is the safe direction: more runs, never fewer proofs.
4. **A sabotage that does not apply is a false red, never a false green.** A no-op, a compile error, a timeout and a missing target all make the rule `blocked`.
5. **G3 is not a guarantee.** Phase 2 makes "proven able to fail" true; it does not make a procedural run binding. The class warning stays.
6. **JUnit is a fallback.** The primary E2E format is Playwright JSON. The JUnit reader maps `testcase name` to `runtimeId`; a JUnit producer that emits leaf-only names will yield `not-run` (never green), and should use JSON instead.
7. **Vitest's JSON reporter loses the timeout text.** Vitest 3 emits `Error: STACK_TRACE_ERROR` for a timed-out test, so the Vitest adapter may classify a timeout as `harness`. Both are non-proof; the Playwright adapter classifies its own `TimeoutError` as `timeout`. This is a reporting nuance, not a green path.
8. **Only known secret file patterns are excluded.** The sandbox drops `.env*`, key/certificate files and package-manager config; an arbitrary committed secret under another name is out of scope. Repository secret hygiene remains the adopter's responsibility.
9. **Packaging is not solved here.** The unscoped npm name `invariant` is already taken by `zertosh/invariant` (2.2.4), and `dist/` is gitignored. Until this package is published under a scope, `init`'s default `npm install invariant@<version>` is a placeholder; pass `--cli-setup`/`--invariant-cmd` to point at a local build or a scoped package.

## Hazards found while reviewing the current tree (fix before the owning task)

These are not hypothetical. Each one would either make Phase 2 red for the wrong reason or let a non-proof through if the task were implemented as originally sketched.

| # | Hazard | Evidence in the current tree | Owning task |
|---|---|---|---|
| H1 | `healthy-registry` never imports its seam, so its sabotage is a no-op | `test/fixtures/healthy-registry/src/checkout.test.ts` asserts `expect(1 + 1).toBe(2)`; the sabotage replaces `src/stock-policy.ts`, which the test never imports | 5, 10 |
| H2 | SELF-004's declared seam is a no-op | `test/self/self-004.test.ts` imports `isProof` directly; `rules/self.yaml` declares `createSabotageSource(root)` and the sabotage replaces `seams/sabotage-source.ts` | 11 |
| H3 | `invariant negative` never discovers checks; the executor cannot build a `SabotageSpec` from a registry-only check | `commands/negative.ts` loads config + registry only; `SabotageSpec.check` is a `DiscoveredCheck` with `file`/`runtimeId` | 4, 5 |
| H4 | `verdict` treats propagated negative findings as **gate** findings | `readStageResults` → `propagatedFindings` → `upstream.findings`; `verdict` puts `upstream.findings` into `gateFindings`, so a no-op would exit 2 instead of 1 | 8 |
| H5 | `verdict` treats a failed negative job as `upstream.job_failed` | `expectsArtifact` accepts `failure` only for the checks stage | 8 |
| H6 | Existing `computeVerdicts` tests default to an empty outcomes map; the new `blocked` producer would turn every enforced `pass` into `blocked` | `test/unit/verdict.test.ts` helper `compute(..., outcomes = new Map())` | 7 |
| H7 | Hard-coded `declared-only` assertions and 18 goldens outside the corpus list | `negative-cli.test.ts`, `verify-cli.test.ts` (summary line + G1 test), `verdict-cli.test.ts`, `walking-skeleton.test.ts`, `report.test.ts`, `test/golden/sabotage-missing-alias/stdout.txt` | 5, 9, 10 |
| H8 | The scheduled run passes `--base ""`; `validate`/`verify` then attempt a diff and exit 2 | `workflow.yml` uses `... \|\| ''`; `changed-files.assertRef` rejects an empty ref | 13 |
| H9 | Playwright `test.describe(...)` and hooks are misclassified by the Vitest AST | `adapter/vitest/ast.ts` `MODIFIERS` has no `describe`; `test.beforeEach` is an invalid shape | 16 |
| H10 | `reportWith` hardcodes `verdict: "pass"` and `negative_control: {status:"not-executed"}` | `test/unit/report.test.ts` helper | 9 |
| H11 | The npm name `invariant` is taken and `dist/` is not published | `npm view invariant` → 2.2.4 (`zertosh/invariant`); `.gitignore` ignores `dist/` | 14 |

## Open questions this plan resolves by default

| # | Question | Default taken | Owning tasks |
|---|---|---|---|
| PEND-12 | How does a sabotage change the code under test without patching production code? | Copy the repo to a temp sandbox and replace the `@seam-alias` module's bytes with the sabotage file. No bundler alias, no source patch, no break flag. | 2, 3 |
| PEND-13 | What does `not-applied` mean? | Both "the copy/replacement failed" and "the replacement was installed but the check stayed green" (a no-op). Both are non-proof; the rule is `blocked`. | 3, 4 |
| PEND-14 | Which verdict does a green-but-unproven check get? | `blocked`. A normal `fail`, `not-run` or `flaky` keeps its own verdict; the negative control cannot launder a red check. | 7 |
| PEND-15 | What if the negative artifact is missing or `executed: false` while enforced rules exist? | Gate failure, exit 2 (`upstream.negative_not_executed` / `negative.outcome_missing`). Never treat `declared-only` as green. | 8 |
| PEND-16 | How is "no secrets and no network" enforced? | Sanitized env (no tokens, no `NODE_OPTIONS`, `HOME` in the sandbox) plus a Node preload that blocks non-loopback sockets. OS-level isolation is not claimed. | 2 |
| PEND-17 | Where does JUnit fit? | A hand-written JUnit XML fallback for `readReports`, with `testcase name` as `runtimeId`; Playwright JSON is the primary E2E format. No new dependency. | 12 |
| PEND-18 | How are multiple adapters configured? | `adapters: [vitest, playwright]` in `.invariant/config.yaml`; `adapter: vitest` remains a single-adapter alias. `--adapter` becomes repeatable. | 15 |
| PEND-19 | SELF-004's declared seam is currently a no-op: the check imports `isProof` directly while the sabotage replaces `seams/sabotage-source.ts`. | Retarget SELF-004 to `packages/cli/src/verdict/proof.ts` and make the report-level assertion exercise a real seam. The registry schema does not change. | 11 |
| PEND-20 | Does Phase 2 need change-detection caching? | No. Run every declared sabotage on every gate; the scheduled run is included. Caching is Phase 3. | 13 |
| PEND-21 | How does Playwright find browsers in the sandbox? | Resolve the browser cache before sanitizing (`PLAYWRIGHT_BROWSERS_PATH`, or the platform default under the original `HOME`) and set it explicitly in the sandbox env. Browser binaries are not credentials; the sandbox never copies a token or a config file. | 17 |
| PEND-22 | Can one check be declared by both a rule and a flow? | Yes (existing behavior). The negative control applies only to enforced-rule checks; flow-level checks stay negative-control-free (PEND-10). | 7 |

## Global Constraints

Inherited from the Phase 0/1 plan, plus the Phase 2 additions.

- **Package:** ESM only, `"type": "module"`, `engines.node: ">=20"`.
- **Runtime dependencies (exactly these three):** `yaml`, `ajv` (draft 2020-12), `typescript`. Do not add an XML parser or a Playwright dependency to the CLI; the JUnit reader is local, and the Playwright adapter runs the project's own `@playwright/test`.
- **TS→ESM rule:** relative imports in `src/` carry `.js`; `packages/cli/vitest.config.ts` maps `./x.js` → `./x.ts` for the test run.
- **The report shape, registry schema and verdict vocabulary are frozen.** `negative_control` gains the value `executed`; `sabotage_verified` gains real `true`; `blocked` gains a producer. No new wire keys.
- **No clocks in artefacts.** `negative-result.json` and `invariant-report.json` contain no timestamps or durations. Outcomes are keyed by check id and rendered in sorted order.
- **Exit precedence is `2 > 1 > 0`.** A non-proof is product red (1); an unexecutable negative stage is gate red (2).
- **No secrets reach a sabotaged run.** The sandbox env removes every token/secret/key/password/credential variable, `GITHUB_*`, `NPM_*`, `AWS_*`, `AZURE_*`, `GOOGLE_*`, `INVARIANT_*`, `ACTIONS_*`, `RUNNER_*`, and `NODE_OPTIONS`; `HOME` and `USERPROFILE` point at the sandbox.
- **No write outside the sandbox.** The sandbox is a temp directory; cleanup runs in `finally`. The copy dereferences source symlinks so a malicious link cannot write back into the repo.
- **The plugin never becomes a test framework** (spec §2): it discovers, runs, maps, verifies, reports. The sabotaged run uses the project's own runner and config.
- **Docs in the repo are in English**; conversation with the human partner is in Portuguese.

## Review Focus

Input classes and failure modes the design implies whose owning code is easy to get wrong. Each line's test is added in the task named in brackets.

1. **A no-op sabotage must not pass.** A green check whose sabotaged run is also green is `not-applied` → `blocked` → exit 1. A verifier that treats "the sabotage file exists" as proof is the exact failure Phase 2 exists to remove. [Tasks 3, 4, 10]
2. **A harness error or timeout must not count as proof.** Only an explicit `AssertionError` / `expected … to …` classification is proof; everything unknown defaults to `harness`. A compile error is not a failed assertion. [Task 3]
3. **The sandbox must not leak secrets or write back.** `.env*`, `.npmrc`, `.git`, `node_modules` contents and credentials are excluded; the env is replaced, not merged; the copy is cleaned up even when the adapter throws. [Task 2]
4. **A single unproven check blocks the whole rule.** `sabotage_verified` is `every`, not `some`; a rule with two checks and one no-op is `blocked`. [Task 7]
5. **Missing negative evidence is a gate failure, not a green.** `verdict` must never infer proof from an absent artifact or an `executed: false` flag while enforced rules exist. [Task 8]
6. **The dogfood must not recurse or go green by accident.** SELF tests call `runVerify`; the outer sabotage replaces a seam that the inner `runVerify` uses. A no-op is a red dogfood run, which is the point. [Task 11]
7. **Multi-adapter identity must not cross-match.** The same `runtimeId` in Vitest and Playwright is two different checks; results are aligned by `(frameworkId, runtimeId)`, not by `runtimeId` alone. [Task 15]
8. **Playwright's JSON shape differs from Vitest's.** Map `spec.ok` / `tests[].status`, skip the top-level project suite in the title path, and never map an unknown status to `pass`. [Task 16]

---

## File Structure

New files and fixture changes:

```
packages/cli/src/adapter/failure.ts                 shared assertion/harness/timeout classifier
packages/cli/src/adapter/vitest/sabotage.ts         copy-and-replace + run + classify for Vitest
packages/cli/src/adapter/junit/xml.ts               minimal JUnit XML reader (PEND-17)
packages/cli/src/negative/sandbox.ts                isolated copy, symlink farm, sanitized env, cleanup
packages/cli/src/negative/execute.ts                enforced checks → SabotageOutcome map
packages/cli/src/assets/negative/no-network.mjs     Node preload: block non-loopback sockets
packages/cli/src/adapter/playwright/index.ts        Part B: Playwright adapter
packages/cli/src/adapter/playwright/ast.ts          Part B: test()/test.describe() discovery
packages/cli/src/adapter/playwright/report.ts       Part B: Playwright JSON → CheckResult[]
packages/cli/src/adapter/playwright/run.ts          Part B: spawn the project's Playwright
packages/cli/src/adapter/playwright/sabotage.ts     Part B: Playwright applySabotage
packages/cli/src/adapter/composite.ts               Part B: merge discovery and route runs by frameworkId
packages/cli/test/unit/adapter-contract.test.ts
packages/cli/test/unit/negative-sandbox.test.ts
packages/cli/test/unit/vitest-sabotage.test.ts
packages/cli/test/unit/negative-execute.test.ts
packages/cli/test/unit/junit.test.ts
packages/cli/test/unit/playwright-report.test.ts
packages/cli/test/integration/multi-adapter.test.ts
packages/cli/test/integration/vue-fastify.test.ts
packages/cli/test/fixtures/sabotage-not-applied/**
packages/cli/test/fixtures/negative-no-op/**
packages/cli/test/fixtures/negative-not-executed/**
packages/cli/test/fixtures/healthy-registry/**        (test now uses its seam)
packages/cli/test/fixtures/no-op-sabotage/**          (expected exit 1)
packages/cli/test/fixtures/sabotage-does-not-compile/** (expected exit 1)
packages/cli/test/fixtures/vue-fastify/**
```

Modified files:

```
packages/cli/src/adapter/api.ts                     SabotageSpec, applySabotage, classifyFailure, env semantics
packages/cli/src/adapter/vitest/index.ts            wire the two new methods
packages/cli/src/adapter/vitest/run.ts              env replace, timeoutMs, file-level errors
packages/cli/src/adapter/registry.ts                Part B: register playwright
packages/cli/src/adapter/align.ts                   Part B: align by (frameworkId, runtimeId)
packages/cli/src/config/model.ts                    Part B: adapters[]
packages/cli/src/config/load.ts                     Part B: normalize adapter/adapters
packages/cli/src/seams/check-runner.ts              Part B: composite runner
packages/cli/src/seams/discovery-source.ts          Part B: composite discovery
packages/cli/src/context.ts                         expose adapters; build the composite
packages/cli/src/commands/negative.ts               execute, artifact outcomes, exit codes
packages/cli/src/commands/verify.ts                 stage 6, dynamic negative_control, empty --base
packages/cli/src/commands/validate.ts               empty --base means "no diff"
packages/cli/src/commands/verdict.ts                outcome parsing, fail-closed, job-status mapping
packages/cli/src/commands/run.ts                    Part B: multiple adapters
packages/cli/src/verdict/compute.ts                 blocked producer
packages/cli/src/report/comment.ts                  proven/checked, negative-control section
packages/cli/src/assets/workflow.yml                schedule, dispatch, timeouts
.github/workflows/invariant.yml                     rendered
.invariant/sabotages/self/proof.ts                  SELF-004's real seam target
.invariant/sabotages/self/sabotage-source.ts        removed (superseded)
.invariant/sabotages/self/check-runner.ts           update to the composite runner signature (Part B)
.invariant/sabotages/self/discovery-source.ts       update to the composite source signature (Part B)
rules/self.yaml                                     SELF-004 seam text + sabotage path
packages/cli/test/unit/vitest-run.test.ts           env semantics
packages/cli/test/unit/verdict.test.ts              blocked producer
packages/cli/test/unit/report.test.ts               executed/proven/blocked comment
packages/cli/test/unit/verdict-stage-results.test.ts negative artifact payload validation
packages/cli/test/unit/align.test.ts                (frameworkId, runtimeId)
packages/cli/test/unit/workflow-render.test.ts      schedule/dispatch/timeouts
packages/cli/test/unit/workflow-drift.test.ts       rendered dogfood copy
packages/cli/test/integration/negative-cli.test.ts  executed negative command
packages/cli/test/integration/verify-cli.test.ts    stage 6
packages/cli/test/integration/verdict-cli.test.ts   negative artifact consumption
packages/cli/test/integration/corpus.test.ts        new hostile case
packages/cli/test/integration/init-cli.test.ts      rendered workflow
packages/cli/test/integration/walking-skeleton.test.ts
packages/cli/test/integration/dogfood-registry.test.ts
packages/cli/test/self/self-003.test.ts             fixture uses the seam
packages/cli/test/self/self-004.test.ts             Phase 2 expectations
packages/cli/test/helpers/stub-adapter.ts           new methods
README.md                                           Phase 2 status, proof semantics, links
docs/adopting.md                                    seam rules, isolation, blocked, Vue+Fastify
docs/deployment.md                                  Phase 2 evidence
```

No change: `packages/cli/src/report/shape.ts`; the wire shape is frozen.

Commands after Phase 2 (Part A; Part B makes `--adapter` repeatable):

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

---

## Tasks

Tasks 1–14 are Part A (the §7 guarantee); tasks 15–18 are Part B (Vue 3 + Fastify). Do them in order; every task's Interfaces block assumes the ones before it.

### Task 1: Adapter contract, sabotage spec and run environment

**Files:**
- Modify: `packages/cli/src/adapter/api.ts`
- Modify: `packages/cli/src/adapter/vitest/run.ts`
- Modify: `packages/cli/src/context.ts` (`unavailableAdapter`)
- Modify: `packages/cli/test/helpers/stub-adapter.ts`
- Test: `packages/cli/test/unit/adapter-contract.test.ts`

**Interfaces:**
- Produces: `RunOpts = { root: string; env?: Record<string, string>; timeoutMs?: number }`; `SabotageSpec = { check: DiscoveredCheck; sabotagePath: string; seamAlias: string; sabotageText: string; workdir: string; env: Record<string, string>; timeoutMs?: number }`; `Adapter` gains `applySabotage(spec: SabotageSpec): Promise<SabotageOutcome>` and `classifyFailure(result: CheckResult): "assertion" | "harness" | "timeout"`.
- `stubAdapter` gains optional `sabotageOutcomes?: Map<string, SabotageOutcome>` and `classifications?: Map<string, "assertion" | "harness" | "timeout">`; defaults are `not-executed` / `harness`.

- [x] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/adapter-contract.test.ts
import { describe, expect, it } from "vitest";
import type { SabotageSpec } from "../../src/adapter/api.js";
import type { DiscoveredCheck } from "../../src/discovery/types.js";
import { stubAdapter } from "../helpers/stub-adapter.js";

const check: DiscoveredCheck = {
  checkId: "sales.a", rules: ["SALES-004"], flows: [], testName: "a",
  file: "a.test.ts", line: 1, frameworkId: "stub", runtimeId: "a",
};

const spec: SabotageSpec = {
  check, sabotagePath: ".invariant/sabotages/a.ts", seamAlias: "src/a.ts",
  sabotageText: "export const a = 1", workdir: "/tmp/x", env: {},
};

describe("Adapter contract", () => {
  it("exposes applySabotage and classifyFailure on every adapter", async () => {
    const adapter = stubAdapter({
      discovered: [], results: [],
      sabotageOutcomes: new Map([["sales.a", { status: "applied", classification: "assertion" }]]),
    });
    expect(adapter.classifyFailure({ runtimeId: "a", outcome: "fail", message: "AssertionError: expected 1 to be 2" })).toBe("assertion");
    await expect(adapter.applySabotage(spec)).resolves.toEqual({ status: "applied", classification: "assertion" });
  });

  it("defaults an unconfigured sabotage to not-executed and an unknown failure to harness", async () => {
    const adapter = stubAdapter({ discovered: [], results: [] });
    await expect(adapter.applySabotage(spec)).resolves.toEqual({ status: "not-executed" });
    expect(adapter.classifyFailure({ runtimeId: "a", outcome: "fail", message: "boom" })).toBe("harness");
  });
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/adapter-contract.test.ts` → FAIL (missing methods).

- [x] **Step 3: Implement the contract**

Add the two methods to `Adapter` and `SabotageSpec` to `adapter/api.ts`. In `run.ts`, change the child environment from merge to replacement:

```ts
env: opts.env ?? process.env
```

`timeoutMs` defaults to `120_000` in `runVitest` and to `600_000` in the Playwright adapter. The shipped `vitestAdapter` and `unavailableAdapter` get fail-closed placeholders (`not-applied` / `harness`) until Task 3 replaces them.

- [x] **Step 4: Pin the env semantics with a real child process**

Add a test in `test/unit/vitest-run.test.ts` that sets `process.env.INVARIANT_TEST_SECRET = "parent-secret"`, runs `runChecks` with an environment containing only `PATH`, `HOME` and (when set) `TMPDIR`, and asserts the child's test sees `undefined`. Vitest needs `HOME`; the secret must not survive.

- [x] **Step 5: Run the tests, then commit**

Run: `cd packages/cli && npx vitest run test/unit/adapter-contract.test.ts test/unit/vitest-run.test.ts` → PASS (15 tests), then `npm test` → PASS (344 tests). Then `git add -A && git commit -m "feat(adapter): sabotage contract, classifyFailure, replace-not-merge env"`

### Task 2: Isolated sandbox, symlink farm and sanitized environment

**Files:**
- Create: `packages/cli/src/negative/sandbox.ts`
- Create: `packages/cli/src/assets/negative/no-network.mjs`
- Test: `packages/cli/test/unit/negative-sandbox.test.ts`

**Interfaces:**
- Produces: `Sandbox = { root: string; cleanup(): Promise<void> }`; `createSandbox(sourceRoot: string, label: string): Promise<Sandbox>`; `sanitizedEnv(base: NodeJS.ProcessEnv, sandboxRoot: string): Record<string, string>`; `NO_NETWORK_PRELOAD: string` (absolute path).
- The sandbox copy excludes `.git`, `node_modules` **contents**, `.env`, `.env.*`, `.npmrc`, `.yarnrc`, `.pnp.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `.worktrees`, `invariant-report.json`, `invariant-comment.md`, `invariant-inputs`, `invariant-doctor.json`.
- `node_modules` is recreated as a **real directory** containing symlinks to each top-level entry of the source `node_modules`, so Vite's cache (`node_modules/.vite`) is written in the sandbox, not through a symlink into the repo. Nested `node_modules` directories are handled the same way.
- `sanitizedEnv` removes the variable families listed in Global Constraints, sets `HOME`/`USERPROFILE`/`TMPDIR` to the sandbox, sets `CI=1`, keeps `PATH`, preserves `PLAYWRIGHT_BROWSERS_PATH` when set, and sets `NODE_OPTIONS=--import <file URL of the preload>`. The preload blocks non-loopback `net.connect`, `http(s).request`, `http2.connect`, `tls.connect`, `dns.lookup` and `fetch`; loopback (`127.0.0.1`, `::1`, `localhost`) is allowed because the app under test may need a local server.

- [x] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/negative-sandbox.test.ts
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSandbox, sanitizedEnv } from "../../src/negative/sandbox.js";
import { makeTmpRepo } from "../helpers/fixture.js";

describe("createSandbox", () => {
  it("copies the tree, excludes secrets and .git, and recreates node_modules", async () => {
    const source = await makeTmpRepo({
      "package.json": "{}",
      "src/a.ts": "export const a = 1",
      ".env": "TOKEN=secret",
      ".git/objects/x": "",
      "node_modules/.bin/x": "",
    });
    const sandbox = await createSandbox(source, "test");
    try {
      expect(await readFile(path.join(sandbox.root, "src/a.ts"), "utf8")).toBe("export const a = 1");
      await expect(stat(path.join(sandbox.root, ".env"))).rejects.toThrow();
      await expect(stat(path.join(sandbox.root, ".git"))).rejects.toThrow();
      expect((await stat(path.join(sandbox.root, "node_modules"))).isDirectory()).toBe(true);
    } finally {
      await sandbox.cleanup();
    }
    await expect(stat(sandbox.root)).rejects.toThrow();
  });
});

describe("sanitizedEnv", () => {
  it("drops credentials and points HOME at the sandbox", () => {
    const env = sanitizedEnv({ PATH: "/bin", GITHUB_TOKEN: "x", HOME: "/home/u", INVARIANT_DOCTOR_TOKEN: "y" }, "/tmp/s");
    expect(env["GITHUB_TOKEN"]).toBeUndefined();
    expect(env["INVARIANT_DOCTOR_TOKEN"]).toBeUndefined();
    expect(env["HOME"]).toBe("/tmp/s");
    expect(env["PATH"]).toBe("/bin");
    expect(env["NODE_OPTIONS"]).toContain("--import");
  });
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/negative-sandbox.test.ts` → FAIL.

- [x] **Step 3: Implement the copy and the farm**

Use `fs.cp(source, root, { recursive: true, dereference: true, filter })`; dereferencing closes the symlink-escape hole. Collect every directory named `node_modules` in the source (skipping its contents) and call `linkFarm(sourceModules, path.join(root, relative))` for each. `linkFarm` reads the top-level entries and creates one symlink per entry; `@scope` entries are linked as directories.

- [x] **Step 4: Implement the no-network preload**

`src/assets/negative/no-network.mjs` patches the modules listed above and allows only loopback. It must be copied into the sandbox so `--import` can load it without resolving the CLI's install. The preload is an asset, so `npm run build` copies it to `dist/assets` automatically.

- [x] **Step 5: Pin the preload with a child process**

Add a test that spawns `node --import <preload> -e "fetch('https://example.com')"` and expects a failure, then spawns the same with `http://127.0.0.1:1` and expects a connection error rather than the block message. This distinguishes "blocked" from "nothing listening".

- [x] **Step 6: Run the tests, then commit**

Run: `cd packages/cli && npx vitest run test/unit/negative-sandbox.test.ts` → PASS (6 tests). Then `git add -A && git commit -m "feat(negative): isolated sandbox, symlink farm, sanitized env, no-network preload"`

### Task 3: Failure classification and Vitest `applySabotage`

**Files:**
- Create: `packages/cli/src/adapter/failure.ts`
- Create: `packages/cli/src/adapter/vitest/sabotage.ts`
- Modify: `packages/cli/src/adapter/vitest/run.ts` (carry a file-level error on an absent check)
- Modify: `packages/cli/src/adapter/vitest/index.ts`
- Test: `packages/cli/test/unit/vitest-sabotage.test.ts`

**Interfaces:**
- Produces: `classifyFailureMessage(outcome: CheckResult["outcome"], message?: string): "assertion" | "harness" | "timeout"`; `applyVitestSabotage(spec: SabotageSpec): Promise<SabotageOutcome>`.
- Classification rules, in this order: timeout (`/timed out|TimeoutError|Test timeout of \d+ms exceeded/i`), assertion (`/AssertionError|expected .* to (be|equal|include|match|throw|have)/`), harness (everything else). An unknown message is **harness**, never assertion. Vitest 3's JSON reporter emits `Error: STACK_TRACE_ERROR` for a timed-out test, so the Vitest adapter may classify that case as `harness`; both are non-proof. The Playwright adapter keeps the explicit `TimeoutError` text.
- `applySabotage` never reports proof for a `pass`, `not-run` (without a file-level harness error) or `flaky` result. A `fail` result is classified; a `not-run` result with a file-level load/compile error is `applied` + `harness`.

- [x] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/vitest-sabotage.test.ts
import { describe, expect, it } from "vitest";
import { applyVitestSabotage } from "../../src/adapter/vitest/sabotage.js";
import { makeVitestRepo } from "../helpers/fixture.js";

const SEAM = `export const policy = () => ({ available: () => 1 });\n`;
const TEST = [
  `import { expect, test } from "vitest";`,
  `import { policy } from "../src/stock-policy";`,
  `// @check sales.rejects-insufficient-stock`,
  `// @rule SALES-004`,
  `test("rejects insufficient stock", () => { expect(policy().available()).toBe(1); });`,
].join("\n");

function spec(root: string, sabotageText: string) {
  return {
    check: { checkId: "sales.rejects-insufficient-stock", rules: ["SALES-004"], flows: [], testName: "rejects insufficient stock", file: "tests/sale.test.ts", line: 3, frameworkId: "vitest", runtimeId: "rejects insufficient stock" },
    sabotagePath: ".invariant/sabotages/sales/stock.ts",
    seamAlias: "src/stock-policy.ts",
    sabotageText,
    workdir: root,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  };
}

it("proves an assertion failure produced by a real module replacement", async () => {
  const root = await makeVitestRepo({ "package.json": "{}", "tests/sale.test.ts": TEST, "src/stock-policy.ts": SEAM });
  const outcome = await applyVitestSabotage(spec(root, "export const policy = () => ({ available: () => Infinity });\n"));
  expect(outcome).toEqual({ status: "applied", classification: "assertion" });
});

it("reports a no-op as not-applied", async () => {
  const root = await makeVitestRepo({ "package.json": "{}", "tests/sale.test.ts": TEST, "src/stock-policy.ts": SEAM });
  const outcome = await applyVitestSabotage(spec(root, SEAM));
  expect(outcome).toEqual({ status: "not-applied" });
});

it("classifies a broken replacement as harness, never proof", async () => {
  const root = await makeVitestRepo({ "package.json": "{}", "tests/sale.test.ts": TEST, "src/stock-policy.ts": SEAM });
  const outcome = await applyVitestSabotage(spec(root, "export const policy = () => {"));
  expect(outcome.status).toBe("applied");
  expect(outcome).toMatchObject({ classification: "harness" });
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/vitest-sabotage.test.ts` → FAIL.

- [x] **Step 3: Implement the classifier and the adapter method**

`failure.ts` owns the three regexes and is shared with Playwright (Part B). `sabotage.ts`:

```ts
export async function applyVitestSabotage(spec: SabotageSpec): Promise<SabotageOutcome> {
  const target = path.join(spec.workdir, spec.seamAlias);
  if (!(await isFileInside(spec.workdir, target))) return { status: "not-applied" };
  try {
    await writeFile(target, spec.sabotageText, "utf8");
  } catch {
    return { status: "not-applied" };
  }
  const [result] = await runChecks([spec.check], {
    root: spec.workdir,
    env: spec.env,
    timeoutMs: spec.timeoutMs ?? 120_000,
  });
  if (result === undefined || result.outcome === "pass") return { status: "not-applied" };
  if (result.outcome === "not-run" && result.message === undefined) return { status: "not-applied" };
  return { status: "applied", classification: classifyFailureMessage(result.outcome, result.message) };
}
```

`runChecks` must, when the target file has a file-level failure and the target check is absent, return the file's error message on the `not-run` result. Read it from `testResults[].message` / `testResults[].status === "failed"` in the Vitest JSON.

- [x] **Step 4: Run the tests, then commit**

Run: `cd packages/cli && npx vitest run test/unit/vitest-sabotage.test.ts test/unit/vitest-run.test.ts` → PASS (19 tests). The suite pins assertion, no-op, missing target, broken replacement (harness) and the Vitest timeout sentinel (non-proof). Then `git add -A && git commit -m "feat(vitest): applySabotage via module replacement, assertion/harness/timeout classifier"`

### Task 4: The negative-control executor

**Files:**
- Create: `packages/cli/src/negative/execute.ts`
- Test: `packages/cli/test/unit/negative-execute.test.ts`

**Interfaces:**
- Produces: `NegativeControlInput = { registry: Registry; root: string; adapters: Adapter[]; discovered: DiscoveredCheck[]; env?: NodeJS.ProcessEnv; timeoutMs?: number }`; `NegativeControlRun = { outcomes: Map<string, SabotageOutcome>; findings: Finding[]; errors: Finding[]; declared: number; executed: boolean }`; `runNegativeControl(input): Promise<NegativeControlRun>`.
- Build `Map<checkId, DiscoveredCheck>` from `discovered`. Every enforced check must map to exactly one discovered check; a missing or duplicate check is an **error** (`negative.check_not_discovered` / `negative.check_ambiguous`), exit 2. `reconcile` normally catches this, but the `negative` job runs independently of `verdict`, so the executor must defend itself.
- For every `enforced` rule and every one of its checks, in registry order:
  1. Read the sabotage through `createSabotageSource(root)` (the SELF-004 seal). A missing file or alias is an **error** (`negative.sabotage_missing` / `negative.seam_alias_missing`), exit 2: the declaration check already owns this and the executor must not execute a half-declared control.
  2. Create a fresh sandbox for the check.
  3. Call the adapter matching `check.frameworkId` with `applySabotage`.
  4. An adapter/sandbox throw is an **error** (`negative.execution_failed`), exit 2; the outcome is `not-applied`.
  5. A non-proof outcome is a **finding**: `negative.sabotage_not_applied`, `negative.sabotage_harness` or `negative.sabotage_timeout`, exit 1.
  6. Clean the sandbox in `finally`.
- `executed` is true only when every enforced check got an outcome and `errors` is empty. A non-proof outcome does not set `executed` false; the stage did run.
- A `not-executed` outcome from an adapter is an **error** (`negative.not_executed`, exit 2), not a product finding: the adapter was asked to apply the sabotage and did not. It sets `executed: false`.
- The executor runs **every** declared sabotage, including checks whose normal run is red. The negative job is parallel to the checks job (spec §9.4) and must not depend on it.

- [x] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/negative-execute.test.ts
import { describe, expect, it } from "vitest";
import { runNegativeControl } from "../../src/negative/execute.js";
import { loadRegistry } from "../../src/registry/load.js";
import { stubAdapter } from "../helpers/stub-adapter.js";
import { makeTmpRepo } from "../helpers/fixture.js";
import { capability } from "../helpers/registry.js";

it("maps every enforced check to an outcome and a non-proof finding", async () => {
  const root = await makeTmpRepo({
    "rules/sales.yaml": capability("SALES-004"),
    ".invariant/sabotages/sales/stock.ts": "// @seam-alias src/stock-policy.ts\nexport const policy = () => 1;\n",
    "src/stock-policy.ts": "export const policy = () => 1;\n",
  });
  const { registry } = await loadRegistry(root);
  const discovered = [{
    checkId: "sales.rejects-insufficient-stock",
    rules: ["SALES-004"],
    flows: [],
    testName: "rejects insufficient stock",
    file: "src/sale.test.ts",
    line: 1,
    frameworkId: "stub",
    runtimeId: "rejects insufficient stock",
  }];
  const adapter = stubAdapter({ discovered: [], results: [], sabotageOutcomes: new Map([["sales.rejects-insufficient-stock", { status: "not-applied" }]]) });
  const run = await runNegativeControl({ registry, root, adapters: [adapter], discovered });
  expect(run.declared).toBe(1);
  expect(run.executed).toBe(true);
  expect(run.outcomes.get("sales.rejects-insufficient-stock")).toEqual({ status: "not-applied" });
  expect(run.findings.map((finding) => finding.code)).toEqual(["negative.sabotage_not_applied"]);
  expect(run.errors).toEqual([]);
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/negative-execute.test.ts` → FAIL.

- [x] **Step 3: Implement the executor**

Read sabotage text once per check and pass it to `applySabotage`. The sandbox label is the check id (sanitized for a directory name). Convert the adapter outcome:

```ts
function findingFor(ruleId: string, checkId: string, outcome: SabotageOutcome): Finding | null {
  if (outcome.status === "not-applied") return negativeFinding("negative.sabotage_not_applied", ...);
  if (outcome.status === "applied" && outcome.classification === "harness") return negativeFinding("negative.sabotage_harness", ...);
  if (outcome.status === "applied" && outcome.classification === "timeout") return negativeFinding("negative.sabotage_timeout", ...);
  // `not-executed` is handled by the caller and goes to `errors`, never here:
  // an adapter that was asked to apply the sabotage and did not is a gate error.
  return null; // assertion = proof
}
```

- [x] **Step 4: Add the missing-adapter and sandbox-throw cases, then commit**

A check whose `frameworkId` has no adapter is `negative.execution_failed` (exit 2), not a crash. A declared enforced check with no discovered test is `negative.check_not_discovered` (exit 2), never silently skipped. A sandbox throw is also `negative.execution_failed`, and the temp directory is removed. Run the tests → PASS (5 tests). Then `git add -A && git commit -m "feat(negative): executor turns every enforced check into a SabotageOutcome"`

### Task 5: `invariant negative` executes the control

**Files:**
- Modify: `packages/cli/src/commands/negative.ts`
- Test: `packages/cli/test/integration/negative-cli.test.ts`
- Update fixture tests: `healthy-registry`, `no-op-sabotage`, `sabotage-does-not-compile`, `sabotage-missing-alias` (the goldens are regenerated in Task 10)

**Interfaces:**
- Produces: `invariant negative [--root <dir>] [--adapter <id>]... [--json] [--out <file>]`.
- The command runs, in order: config + registry load and §5 validation → discovery through `createDiscoverySource(config)` → `reconcile(registry, discovery)` → `checkDeclared` → `runNegativeControl`. A discovery error or reconcile finding is exit 2 and `executed: false`; the executor cannot run a check that was never discovered (H3). When `declared === 0`, discovery is skipped and the artifact is `{declared: 0, executed: true, outcomes: {}, findings: []}`.
- Resolve the adapters with `findAdapter` for every configured id (one id in Part A; the composite in Part B). An unknown adapter is exit 2 before any sandbox is created.
- Human first line, verbatim:
  - `negative control: executed — <proven>/<declared> checks proven able to fail`
  - `negative control: not executed — <reason>` when the executor had a gate error.
- Machine artifact: `{ declared: number; executed: boolean; outcomes: Record<string, SabotageOutcome>; findings: Finding[] }`, with `outcomes` keys sorted.
- Exit: `0` every declared check is an `applied/assertion`; `1` a non-proof outcome (product red); `2` invalid registry/config, an orphan enforced check, a broken declaration, an unknown adapter or a sandbox/execution error.
- The declaration checks run first; an invalid declaration never executes a run. The help text must be updated too (it still documents `executed: false`).

- [x] **Step 1: Write the failing test**

```ts
// packages/cli/test/integration/negative-cli.test.ts
it("executes the declared sabotage and proves the walking skeleton", async () => {
  const run = await runFixture("healthy-registry", { args: ["negative", "--json"] });
  expect(run.exitCode).toBe(0);
  const artifact = JSON.parse(run.stdout) as { declared: number; executed: boolean; outcomes: Record<string, unknown> };
  expect(artifact.declared).toBe(1);
  expect(artifact.executed).toBe(true);
  expect(artifact.outcomes["sales.rejects-insufficient-stock"]).toEqual({ status: "applied", classification: "assertion" });
});

it("marks a no-op sabotage as a product red", async () => {
  const run = await runFixture("no-op-sabotage", { args: ["negative", "--json"] });
  expect(run.exitCode).toBe(1);
  const artifact = JSON.parse(run.stdout) as { outcomes: Record<string, unknown> };
  expect(artifact.outcomes["sales.rejects-insufficient-stock"]).toEqual({ status: "not-applied" });
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npm run build && npx vitest run test/integration/negative-cli.test.ts` → FAIL (the command still prints declared-only).

- [x] **Step 3: Implement the command**

Replace `NOTICE` with the dynamic first line. Resolve the adapter(s) with `findAdapter`; an unknown adapter is exit 2. Call `runNegativeControl`; write the artifact; print findings on stderr; return `EXIT.PRODUCT_BROKEN` for non-proof findings and `EXIT.GATE_BROKEN` for `errors`. The `--json` output is the artifact, not the human line.

- [x] **Step 4: Update the fixture tests**

Update `healthy-registry`'s test in this task: import `policy` and assert `policy().available() === 1`, so the sabotage's `Infinity` is an assertion failure rather than an unused module. Update `sabotage-does-not-compile`'s test the same way, so the invalid replacement is actually loaded. Add a tagged test and a seam to `sabotage-missing-alias` so discovery/reconcile pass and the missing alias is the failure under test. `no-op-sabotage` keeps its unused seam and expects exit 1. Update `negative-cli.test.ts`'s old `NOTICE` assertion and `test/golden/sabotage-missing-alias/stdout.txt` to the new first line. Run the integration test → PASS (6 tests).

- [x] **Step 5: Commit**

`git add -A && git commit -m "feat(negative): execute declared sabotages, artifact outcomes, honest exit codes"`

### Task 6: `verify` stage 6

**Files:**
- Modify: `packages/cli/src/commands/verify.ts`
- Modify: `packages/cli/src/context.ts` (expose the resolved adapter; Part A)
- Test: `packages/cli/test/integration/verify-cli.test.ts`
- Update goldens: every fixture whose `verify` runs an enforced rule

**Interfaces:**
- `runVerify` calls `runNegativeControl` after stage 5 and before `computeVerdicts`.
- `guarantee.negative_control` is `"executed"` when the executor ran (`executed === true`); `"declared-only"` only when it could not run (and then the exit code is 2 when enforced rules exist).
- `negative.errors` is a gate failure: publish no rule verdicts (same shape as an adapter failure) and exit 2.
- `negative.findings` is product data: keep the rule verdicts, add the findings to the report's `integrity`, and let the `blocked` verdicts drive exit 1.
- The stage never reads a `--negative-result` artifact; `verify` is the in-process path. The CI path is `verdict` (Task 8).

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/integration/verify-cli.test.ts
it("reports executed and proves a real sabotage", async () => {
  const run = await runFixture("healthy-registry", { args: ["verify"] });
  expect(run.exitCode).toBe(0);
  expect(run.report?.guarantee.negative_control).toBe("executed");
  expect(run.report?.rules[0]?.sabotage_verified).toBe(true);
});

it("blocks a rule whose sabotage is a no-op", async () => {
  const run = await runFixture("no-op-sabotage", { args: ["verify"] });
  expect(run.exitCode).toBe(1);
  expect(run.report?.rules[0]?.verdict).toBe("blocked");
  expect(run.report?.rules[0]?.sabotage_verified).toBe(false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npm run build && npx vitest run test/integration/verify-cli.test.ts` → FAIL.

- [ ] **Step 3: Implement stage 6**

Replace the `NEGATIVE_CONTROL` constant and `declaredOutcomes(registry)` with the executor's map. The class and doctor computation stay untouched. On `errors`, `publish({ verdicts: empty, integrity: [...gate, ...negative.errors], ... })`; on success, `publish` with the outcomes and `negativeControl: "executed"`.

- [ ] **Step 4: Run the focused tests, then commit**

Run: `cd packages/cli && npx vitest run test/integration/verify-cli.test.ts` → PASS. The SELF tests are repaired and run in Task 11; do not run `test/self` here, because their fixtures still assume the declared-only delivery. Then `git add -A && git commit -m "feat(verify): execute the negative control as stage 6"`

### Task 7: `blocked` verdicts

**Files:**
- Modify: `packages/cli/src/verdict/compute.ts`
- Test: `packages/cli/test/unit/verdict.test.ts`

**Interfaces:**
- A check that is declared by at least one `enforced` rule and whose normal outcome is `pass` becomes `blocked` unless `isProof(outcome)` is true.
- A check that belongs only to a `draft`/`deprecated` rule, or only to a flow, keeps `pass`; the proof is still recorded in `negative_control` and `sabotage_verified`.
- A normal `fail`, `not-run` or `flaky` keeps its own verdict, even when the sabotage was proof.
- `sabotageVerified` stays `every(check => isProof(check.negativeControl))`; a rule with two checks and one no-op is `blocked`.
- **Test migration (H6):** the existing `verdict.test.ts` helper defaults `outcomes` to an empty map and its assertions expect `negativeControl: {status:"not-executed"}`. After this task, every enforced `pass` with no outcome is `blocked`, so the helper must default to a proof for every enforced check. Keep the old roll-up expectations meaningful, and add explicit `not-executed` / `not-applied` / `applied/harness` cases that assert `blocked`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/verdict.test.ts
it("blocks a green check that is not proven, and leaves a draft rule alone", () => {
  const { checks, rules } = computeVerdicts({
    registry: registryWith({ enforced: "SALES-004", draft: "SALES-005" }),
    discovered: [check("sales.enforced", ["SALES-004"]), check("sales.draft", ["SALES-005"])],
    results: [pass("sales.enforced"), pass("sales.draft")],
    outcomes: new Map([
      ["sales.enforced", { status: "not-applied" }],
      ["sales.draft", { status: "not-executed" }],
    ]),
  });
  expect(checks.find((c) => c.checkId === "sales.enforced")?.verdict).toBe("blocked");
  expect(checks.find((c) => c.checkId === "sales.draft")?.verdict).toBe("pass");
  expect(rules.find((r) => r.ruleId === "SALES-004")?.sabotageVerified).toBe(false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/verdict.test.ts` → FAIL.

- [ ] **Step 3: Implement the producer**

Build `enforcedCheckIds` from `registry.rules.filter(status === "enforced").flatMap(checks)`. In `buildCheckVerdicts`, after `verdictOf(result)`:

```ts
const enforced = enforcedCheckIds.has(checkId);
const verdict = base === "pass" && enforced && !isProof(outcome) ? "blocked" : base;
```

The reason stays `check.blocked`.

- [ ] **Step 4: Run the tests, then commit**

Run: `cd packages/cli && npx vitest run test/unit/verdict.test.ts` → PASS. Then `git add -A && git commit -m "feat(verdict): produce blocked for green checks without proof"`

### Task 8: `verdict` consumes the negative artifact fail-closed

**Files:**
- Modify: `packages/cli/src/commands/verdict.ts`
- Test: `packages/cli/test/integration/verdict-cli.test.ts`, `packages/cli/test/unit/verdict-stage-results.test.ts`
- Update fixtures/goldens: `upstream-cancelled`, `report-missing`, and the new `negative-*` cases

**Interfaces:**
- `StageResult.negative` gains `outcomes: Record<string, SabotageOutcome>`.
- The payload validator accepts and validates `outcomes`; an unknown status/classification is `upstream.artifact_missing`. `executed: true` without `outcomes` is also a shape mismatch.
- If the registry has enforced checks and the negative artifact is missing, has `executed !== true`, or lacks an outcome for an enforced check, the result is a **gate** finding (`upstream.negative_not_executed` / `negative.outcome_missing`) and exit 2.
- A negative job status of `failure` is **expected and read**, like a failed checks job: `run`/`negative` exit 1 on a non-proof, so the job status cannot be the gate decision. It must not become `upstream.job_failed`; the product red comes from the `blocked` rule. `cancelled`/`skipped`/missing remain gate failures.
- **Product vs gate findings (H4):** when `executed: true`, the negative artifact's `findings` are product evidence, not gate failures. Do **not** propagate them into `upstream.findings` (which `verdict` turns into `gateFindings`); the `blocked` verdicts and `checks[].negative_control` carry the red. When `executed: false`, they are gate findings and exit 2. The current `propagatedFindings` treats every negative finding as gate, so this is a required change, not an optional cleanup.
- `guarantee.negative_control` is `"executed"` only when the artifact says so; the report still carries the per-check outcomes.
- `computeVerdicts` receives the outcomes map.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/integration/verdict-cli.test.ts
it("makes a no-op sabotage a product red, not a gate failure", async () => {
  const run = await runFixture("negative-no-op", {
    args: ["verdict", "--inputs", ".", "--job-status", "invariant-registry=success", "--job-status", "invariant-checks=success", "--job-status", "invariant-negative=failure"],
  });
  expect(run.exitCode).toBe(1);
  expect(run.report?.guarantee.negative_control).toBe("executed");
  expect(run.report?.rules[0]?.verdict).toBe("blocked");
});

it("is red when the negative stage did not execute", async () => {
  const run = await runFixture("negative-not-executed", { args: ["verdict", "--inputs", ".", "--job-status", "invariant-negative=success"] });
  expect(run.exitCode).toBe(2);
  expect(run.report?.integrity.map((f) => f.code)).toContain("upstream.negative_not_executed");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npm run build && npx vitest run test/integration/verdict-cli.test.ts` → FAIL.

- [ ] **Step 3: Implement the payload, the job-status mapping and the roll-up**

Add `outcomeProblem(value)` (status enum; `applied` requires `classification` in `assertion | harness | timeout`). In `expectsArtifact`/`explainsFailure`, special-case `stage === "negative"`: a failed negative job is read when the artifact says `executed: true`. In `propagatedFindings`, return `[]` for an `executed: true` negative artifact and its findings for an `executed: false` one. In `readStageResults`, collect the outcomes and cross-check every enforced check id from the registry. Rewrite the existing `verdict-stage-results.test.ts` case "reports a failed negative job as upstream.job_failed": it must now expect the artifact to be read; add a case where the failed job has `executed: true` and a `not-applied` outcome and the result is product, not gate. The "extended negative payload" case gains `outcomes`. Keep the existing `baseline.regressed` behavior.

- [ ] **Step 4: Add the two fixtures and update goldens**

`negative-no-op` is the healthy registry with the no-op sabotage and an `invariant-negative/negative-result.json` whose outcome is `not-applied`. `negative-not-executed` is the healthy registry with `executed: false` and no outcomes. Run `UPDATE_GOLDENS=1` only after inspecting the expected exit codes, then run the tests → PASS.

- [ ] **Step 5: Commit**

`git add -A && git commit -m "feat(verdict): consume negative outcomes, fail closed on missing proof"`

### Task 9: Report and PR comment

**Files:**
- Modify: `packages/cli/src/report/comment.ts`
- Test: `packages/cli/test/unit/report.test.ts`
- Update goldens: every `comment.md`

**Interfaces:**
- When `guarantee.negative_control === "executed"`, print a section:
  ```
  ### Negative control

  Executed — N of M enforced checks proven able to fail.
  ```
  and one line per unproven check: `<rule> / <check> — <status>` (for `applied`, include the classification). The counts come from enforced rules' `check_ids` and `isProof(checks[].negative_control)`.
- When `negative_control === "declared-only"`, keep the banner, reworded without the Phase 2 placeholder: `Seam sabotage was NOT executed in this run. No rule is proven able to fail.` This only happens on a gate failure now.
- `ruleText` keeps `proven` only for `sabotage_verified`; everything else is `checked`.
- The class warning stays for G3; a proven rule in G3 is still not a guarantee.
- **Test helper (H10):** `reportWith` currently hardcodes `verdict: "pass"` for every rule and `negative_control: { status: "not-executed" }` for every check. Extend it with `negativeOutcome?: SabotageOutcome`, `ruleVerdict?: Verdict` and per-rule/check overrides, or build the two test reports as full literals. The test sketches above use overrides the helper does not have today.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/report.test.ts
it("says executed and proven only when the report proves every check", () => {
  const md = renderComment(reportWith({
    negativeControl: "executed",
    rules: [{ rule_id: "SALES-004", status: "enforced", verdict: "pass", sabotage_verified: true, check_ids: ["sales.a"], statement: "x" }],
    checks: [{ check_id: "sales.a", negative_control: { status: "applied", classification: "assertion" } }],
  }));
  expect(md).toContain("Executed — 1 of 1 enforced checks proven able to fail.");
  expect(md).toContain("proven");
  expect(md).not.toContain("Seam sabotage was NOT executed");
});

it("lists a blocked check and never calls it proven", () => {
  const md = renderComment(reportWith({
    negativeControl: "executed",
    rules: [{ rule_id: "SALES-004", status: "enforced", verdict: "blocked", sabotage_verified: false, check_ids: ["sales.a"], statement: "x" }],
    checks: [{ check_id: "sales.a", negative_control: { status: "not-applied" } }],
  }));
  expect(md).toContain("not-applied");
  expect(md).toContain("checked");
  expect(md).not.toContain("(proven)");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/report.test.ts` → FAIL.

- [ ] **Step 3: Implement the section and the conditional banner**

The comment module imports `isProof` from `../verdict/proof.js`; it is a pure function and does not create I/O. Use `cell()`/`escapeText()` for every id and status.

- [ ] **Step 4: Update the goldens, then commit**

Run `UPDATE_GOLDENS=1 npx vitest run test/integration` and inspect **every** comment diff: a green rule must say `proven` only when the report has a proof; a no-op must say `checked` and list `not-applied`. Then `git add -A && git commit -m "feat(report): executed negative control, proven/checked, per-check reasons"`

### Task 10: Corpus, fixtures and goldens

**Files:**
- Modify: `packages/cli/test/fixtures/{healthy-registry,no-op-sabotage,sabotage-does-not-compile,not-run-check,flaky-check,upstream-cancelled,report-missing,empty-registry}/**`
- Create: `packages/cli/test/fixtures/sabotage-not-applied/**`
- Modify: `packages/cli/test/integration/corpus.test.ts` (add the case)
- Update: `packages/cli/test/golden/**`

**Interfaces:**
- `healthy-registry`: the test was updated in Task 5 to import `policy` and assert `policy().available()`; the sabotage returns `Infinity`; expected exit 0, `executed`, `sabotage_verified: true`.
- `no-op-sabotage`: the test does not use the seam; expected exit 1, rule `blocked`, outcome `not-applied`.
- `sabotage-does-not-compile`: the test was updated in Task 5 to import the seam; the invalid replacement is loaded; expected exit 1, outcome `applied/harness`, rule `blocked`.
- `sabotage-not-applied`: a seam file exists but the test does not import it; expected exit 1, outcome `not-applied`. This pins the difference between "the file exists" and "the seam was exercised".
- `not-run-check` / `flaky-check`: the normal check is not green; the negative stage still runs and its outcome is recorded; the rule keeps `not-run`/`flaky`; exit 1.
- `upstream-cancelled` / `report-missing`: their negative artifacts must be valid and `executed: true` with outcomes, so the fixture pins the intended upstream failure, not an accidental `negative_not_executed`.
- `empty-registry`: zero enforced checks; `executed: true`, zero outcomes, exit 0; the comment says no enforced rules.
- `walking-skeleton`: the generated skeleton's sabotage replaces `invariant-example/limiter.ts` and the test imports `./limiter`, so it is a real proof; the golden becomes `negative_control: "executed"`, `sabotage_verified: true`, exit 0. `walking-skeleton.test.ts` hardcodes `declared-only` / `false` today and must be updated with the golden.
- `orphan-rule` / `orphan-check` / `invalid-registry`: stages 1–3 stop before the negative stage; `declared-only` remains honest; exit 2.
- **Hard-coded assertions and stdout goldens (H7):** update `negative-cli.test.ts`'s old notice, `verify-cli.test.ts`'s summary line and "never claims G1" test, `verdict-cli.test.ts`'s `declared-only` assertion, `walking-skeleton.test.ts`'s `sabotage_verified` / `negative_control`, `report.test.ts`'s banner tests, `test/golden/sabotage-missing-alias/stdout.txt`, and every `stdout.txt` / `comment.md` / `report.json` that carries the old banner. The 18 affected goldens are not all in the corpus `CASES` list; `walking-skeleton` and `flaky-check` are separate.
- The corpus list gains `sabotage-not-applied`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/integration/corpus.test.ts
const CASES = [/* existing */, "sabotage-not-applied"] as const;

it.each(CASES)("%s", async (name) => {
  const expected = await expectedFor(name);
  ...
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npm run build && npx vitest run test/integration/corpus.test.ts` → FAIL listing the new fixture and the changed exit codes.

- [ ] **Step 3: Update every fixture's test to exercise its seam**

The rule is simple: a check that never imports the module named by its `@seam-alias` is a **no-op**. For the healthy cases, the test must import the seam and assert the behaviour the rule states. For the intentionally hostile cases, leave the no-op and pin `not-applied`.

- [ ] **Step 4: Regenerate the goldens and inspect them**

Run `UPDATE_GOLDENS=1 npx vitest run test/integration/corpus.test.ts`. Inspect every `report.json` and `comment.md`:
- `healthy-registry`: `negative_control: "executed"`, `sabotage_verified: true`, exit 0;
- `no-op-sabotage` / `sabotage-does-not-compile`: exit 1, rule `blocked`, no `proven`;
- `upstream-cancelled` / `report-missing`: exit 2, the intended `upstream.*` code;
- `orphan-*` / `invalid-registry`: exit 2, `declared-only` banner.

- [ ] **Step 5: Run the focused corpus, then commit**

Run: `cd packages/cli && npx vitest run test/integration/corpus.test.ts` → PASS. Then `git add -A && git commit -m "test(corpus): executed negative control, no-op/not-applied/harness pinned"`

### Task 11: Dogfood repair — make every SELF sabotage bite

**Files:**
- Modify: `rules/self.yaml` (SELF-004 seam text and sabotage path)
- Create: `.invariant/sabotages/self/proof.ts`
- Delete: `.invariant/sabotages/self/sabotage-source.ts`
- Modify: `packages/cli/test/self/self-003.test.ts`, `packages/cli/test/self/self-004.test.ts`
- Test: `packages/cli/test/integration/dogfood-registry.test.ts`

**Interfaces:**
- SELF-004's check imports `isProof` from `src/verdict/proof.ts`; the sabotage replaces that module:
  ```ts
  // .invariant/sabotages/self/proof.ts
  // @seam-alias packages/cli/src/verdict/proof.ts
  export function isProof() {
    return true;
  }
  ```
  The declaration's `seam` text becomes `isProof(outcome)`; no schema change.
- SELF-003's inner fixture test imports `policy` and asserts `available() === 1`, so the inner `runVerify` is green under normal conditions and the outer `changed-files` sabotage removes the immutability finding. Without this, the inner rule becomes `blocked` and the outer assertion fails for the wrong reason.
- SELF-004's report-level test asserts both directions:
  1. a fixture whose check exercises the seam → exit 0, `negative_control: "executed"`, `sabotage_verified: true`;
  2. a fixture whose check does not → exit 1, rule `blocked`, `sabotage_verified: false`.
- SELF-001, SELF-002 and SELF-005 keep their fixtures; their sabotages already replace a module that the check reaches through the composition root.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/self/self-004.test.ts
it("records executed and a proof for a fixture that exercises its seam", async () => {
  const root = await makeVitestRepo({
    "package.json": JSON.stringify({ name: "self-004", type: "module", private: true }),
    "rules/sales.yaml": capability("SALES-004"),
    "src/sale.test.ts": `import { expect, test } from "vitest";\nimport { policy } from "./stock-policy";\n// @check sales.rejects-insufficient-stock\n// @rule SALES-004\ntest("rejects insufficient stock", () => { expect(policy().available()).toBe(1); });\n`,
    ".invariant/sabotages/sales/stock.ts": "// @seam-alias src/stock-policy.ts\nexport const policy = () => ({ available: () => Infinity });\n",
    "src/stock-policy.ts": "export const policy = () => ({ available: () => 1 });\n",
  });
  const { report, code } = await runVerify({ root });
  expect(code).toBe(0);
  expect(report.guarantee.negative_control).toBe("executed");
  expect(report.rules.every((rule) => rule.sabotage_verified)).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/self/self-004.test.ts` → FAIL.

- [ ] **Step 3: Fix SELF-004 and SELF-003, then run the dogfood**

Change the registry and the sabotage file as above. Update the report-level assertions. Run `npm run dogfood` → expected exit 0, five green rules, `guarantee.class: "G3"` (the repo's honest class), `guarantee.negative_control: "executed"`, and every rule `sabotage_verified: true`.

- [ ] **Step 4: Prove the dogfood can go red**

On a scratch branch, change `.invariant/sabotages/self/check-runner.ts` to a runner that returns `not-run` for every check (the real behaviour for the fixture), run `npm run dogfood`, and record exit 1 with `SELF-001: blocked`. Revert. This is the acceptance evidence that a no-op is a false red.

- [ ] **Step 5: Run the tests, then commit**

Run: `cd packages/cli && npm test` → PASS. Then `git add -A && git commit -m "feat(dogfood): execute all five SELF sabotages; SELF-004 targets proof.ts"`

### Task 12: JUnit XML fallback

**Files:**
- Create: `packages/cli/src/adapter/junit/xml.ts`
- Modify: `packages/cli/src/adapter/vitest/report.ts` (`readReports` tries JSON, then JUnit)
- Test: `packages/cli/test/unit/junit.test.ts`

**Interfaces:**
- `readJunitXml(text: string): CheckResult[] | null`; `null` for malformed XML or no `<testcase>`.
- Mapping: `<testcase name="..." classname="...">` → `runtimeId = name`; a child `<failure>` → `fail` with its `message`; `<skipped/>` → `not-run`; otherwise `pass`. A `classname` is kept only as a file hint; the report has no file, so alignment is by `runtimeId`.
- The parser handles the JUnit subset: `<?xml?>`, comments, CDATA, self-closing tags, single/double-quoted attributes, and the five predefined entities. It does not handle namespaces beyond ignoring a prefix; unknown structures are skipped, never guessed.
- `readReports` returns the first readable format; a JSON file wins over a JUnit file when both are supplied. A file that is not JUnit returns `null`, not an empty list.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/junit.test.ts
import { readJunitXml } from "../../src/adapter/junit/xml.js";

it("maps pass, fail and skipped test cases", () => {
  const xml = `<?xml version="1.0"?><testsuites><testsuite name="s"><testcase name="ok" classname="a.test.ts"/><testcase name="bad" classname="a.test.ts"><failure message="AssertionError: expected 1 to be 2"/></testcase><testcase name="skip"><skipped/></testcase></testsuite></testsuites>`;
  expect(readJunitXml(xml)).toEqual([
    { runtimeId: "ok", outcome: "pass" },
    { runtimeId: "bad", outcome: "fail", message: "AssertionError: expected 1 to be 2" },
    { runtimeId: "skip", outcome: "not-run" },
  ]);
});

it("returns null for malformed XML instead of an empty success", () => {
  expect(readJunitXml("<testsuite><testcase")).toBeNull();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/junit.test.ts` → FAIL.

- [ ] **Step 3: Implement the parser and wire it in**

Keep the parser small and linear. Decode `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`; leave unknown entities as written. Strip a namespace prefix (`ns:testcase`) before matching. `readReports` tries each path: JSON first, then JUnit; it returns the first non-null list.

- [ ] **Step 4: Run the tests, then commit**

Run: `cd packages/cli && npx vitest run test/unit/junit.test.ts test/unit/vitest-run.test.ts` → PASS. Then `git add -A && git commit -m "feat(adapter): JUnit XML fallback for existing reports (PEND-11)"`

### Task 13: Scheduled full run

**Files:**
- Modify: `packages/cli/src/assets/workflow.yml`
- Modify: `.github/workflows/invariant.yml` (rendered dogfood copy)
- Modify: `packages/cli/src/commands/validate.ts`, `packages/cli/src/commands/verify.ts` (empty `--base`)
- Test: `packages/cli/test/unit/workflow-render.test.ts`, `packages/cli/test/unit/workflow-drift.test.ts`, `packages/cli/test/integration/init-cli.test.ts`, `packages/cli/test/integration/validate-cli.test.ts`, `packages/cli/test/integration/verify-cli.test.ts`

**Interfaces:**
- `on:` gains `schedule: - cron: "0 3 * * *"` and `workflow_dispatch: {}`; `pull_request`, `merge_group` and `workflow_call` stay.
- `timeout-minutes`: 10 for registry, 20 for checks, 30 for negative, 10 for verdict.
- The PR-comment step stays `if: github.event_name == 'pull_request'`; the artifact upload runs on every event. A scheduled red run fails the workflow without a comment.
- The template has no new placeholders; `init` renders the same four.
- **Empty `--base` is absent (H8).** The template passes `--base "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || '' }}"`; on `schedule` and on a `workflow_call` without a PR the value is `""`. Today `validate`/`verify` treat it as a real ref and `changed-files.assertRef("")` fails, producing `immutability.diff_unavailable` (exit 2). Treat `""` as no base in both commands and pin it with a test: `validate --base ""` behaves exactly like `validate`; `verify --base ""` does not attempt a diff and does not claim immutability.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/workflow-render.test.ts
it("triggers on a schedule and a manual dispatch", async () => {
  const rendered = renderWorkflow(await readFile(TEMPLATE, "utf8"), params);
  expect(rendered).toContain("schedule:");
  expect(rendered).toContain("workflow_dispatch:");
  expect(rendered).toContain("timeout-minutes: 30");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/workflow-render.test.ts` → FAIL.

- [ ] **Step 3: Update the template and the dogfood workflow**

Add the triggers and timeouts. Re-render the dogfood copy with the repository's `cli-setup`/`invariant-cmd`; keep the existing App-token and doctor steps.

- [ ] **Step 4: Run the tests, then commit**

Run: `cd packages/cli && npx vitest run test/unit/workflow-render.test.ts test/unit/workflow-drift.test.ts test/integration/init-cli.test.ts` → PASS. Then `git add -A && git commit -m "feat(ci): scheduled full run and job timeouts"`

### Task 14: README, adoption guide and deployment record

**Files:**
- Modify: `README.md`, `docs/adopting.md`, `docs/deployment.md`
- Test: none (docs), but the README's commands must match `--help`

**Interfaces:**
- README: replace the Phase 0/1 guarantee-status block with the Phase 2 status. State the proof rule: a rule is `proven` only when every check's sabotaged run failed with an assertion; a no-op/harness/timeout is `blocked`; G3 is still not a guarantee. Add the link to this plan in Development.
- Update the `invariant-negative` job description in both README and `docs/adopting.md`: it now **executes** the sabotaged runs in isolated copies, not just validates declarations. Expand "What you get today" to Phase 2.
- **Packaging note (H11):** the unscoped npm name `invariant` is taken and `dist/` is gitignored. Document the two working options: publish as a scoped package, or pass `--cli-setup`/`--invariant-cmd` pointing at a local build/git install. Do not advertise `npm install invariant@0.1.0` as if it worked.
- `docs/adopting.md`: add "Writing a seam and a sabotage" with the module-replacement rules:
  - the seam module is small and has one collaborator;
  - the sabotage exports the same names and has no relative imports (or imports that resolve from the target's directory);
  - the sabotage must make the check fail **by assertion**, not by throwing a custom error;
  - a no-op is red; fix the seam, not the sabotage.
  Add "What the sandbox removes" (secrets, `.git`, `.env`, `node_modules` cache isolation) and "What is not claimed" (OS-level network isolation, G3 bindingness).
- `docs/deployment.md`: add the Phase 2 evidence: the dogfood run and the red PR with a no-op sabotage; keep the current class **G3** and say the guarantee is binding only at G1/G2.
- The README's CLI block gains `--adapter` (repeatable) and the new `negative` output.

- [ ] **Step 1: Rewrite the README status**

Delete "The complete guarantee of §7 does not exist until Phase 2." Replace it with the Phase 2 rule and the residual limits. The word `proven` appears only next to `sabotage_verified: true`.

- [ ] **Step 2: Rewrite the adoption guide sections**

Keep the bootstrap sequence; add the seam/sabotage rules and the sandbox limits. Add the Vue 3 + Fastify section from Task 17 after Part B lands.

- [ ] **Step 3: Record the evidence**

Run `npm run dogfood`, save the report, and link the run in `docs/deployment.md`. Open a real PR with a no-op sabotage, record the red `invariant-verdict` check URL, close it unmerged. State the class honestly.

- [ ] **Step 4: Commit**

`git add -A && git commit -m "docs: Phase 2 guarantee, seam/sabotage rules, deployment evidence"`

---

## Part B — Vue 3 + Fastify

Part B is an extension. It can land after Part A without changing any Part A contract. It adds multiple adapters in one gate and a Playwright adapter for real browser E2E.

### Task 15: Multiple adapters in one gate

**Files:**
- Modify: `packages/cli/src/config/model.ts`, `packages/cli/src/config/load.ts`, `packages/cli/schema/config.schema.json`
- Create: `packages/cli/src/adapter/composite.ts`
- Modify: `packages/cli/src/seams/discovery-source.ts`, `packages/cli/src/seams/check-runner.ts`, `packages/cli/src/context.ts`
- Modify: `packages/cli/src/adapter/align.ts`
- Modify: `packages/cli/src/commands/run.ts`, `packages/cli/src/commands/verify.ts`
- Modify: `packages/cli/test/helpers/stub-adapter.ts`
- Test: `packages/cli/test/integration/multi-adapter.test.ts`, `packages/cli/test/unit/align.test.ts`

**Interfaces:**
- `Config` gains `adapters: string[]`; `adapter` remains a single-adapter alias.
  - Only `adapters` → use it.
  - Only `adapter` → `[adapter]`.
  - Both → `config.adapter_conflict` finding (exit 2); do not guess.
  - Neither → `["vitest"]`.
- `adapters` must be a non-empty array of unique strings.
- `createDiscoverySource(config)` returns a composite: for each id, `findAdapter(id)`; an unknown id is a discovery error naming the id; merge checks/errors in config order.
- `createCheckRunner(adapters)` groups checks by `frameworkId` and calls the matching adapter's `run`; an unknown framework is an error union value, not a crash.
- `CheckResult` gains optional `frameworkId`; `runChecks` and the Playwright runner set it. `alignReportResults` matches on `(frameworkId ?? "", runtimeId)`, consuming each result at most once.
- `--adapter` becomes repeatable; each occurrence appends. `--adapter vitest --adapter playwright` overrides the config. `--adapter` with a single value keeps the old behavior.
- `--reports <file>`: each adapter's `readReports` is tried with the same list; an adapter returns `null` for a format it does not understand. An optional `<adapter>=<file>` prefix routes a report to one adapter; the unprefixed form stays backward compatible.
- The SELF-001/SELF-002 sabotage files update to the new `createCheckRunner(adapters)` / `createDiscoverySource(config)` signatures.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/integration/multi-adapter.test.ts
it("discovers and runs two adapters without cross-matching equal runtime ids", async () => {
  const root = await makeTmpRepo({
    ".invariant/config.yaml": "adapters: [stub-a, stub-b]\n",
    "rules/sales.yaml": capability("SALES-004"),
  });
  const { config } = await loadConfig(root);
  expect(config.adapters).toEqual(["stub-a", "stub-b"]);
  // The helper registers two stubs that both discover a check named "same";
  // only the stub whose frameworkId owns the check may satisfy it.
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/integration/multi-adapter.test.ts` → FAIL.

- [ ] **Step 3: Implement the config and the composite**

Update the schema with `adapters` (array, `minItems: 1`, `uniqueItems: true`) and keep `adapter` for compatibility. The loader's `mergeConfig` normalizes; a conflict is a finding, not a silent pick. `prepareVerify` returns `adapters: Adapter[]`; `context.runner` is the composite.

- [ ] **Step 4: Update the SELF sabotages and the stub adapter, then commit**

The SELF-001 sabotage's `run` receives the checks; it already returns `pass` for each. The signature change is only the factory parameter. The SELF-002 sabotage returns `{ checks: [], errors: [] }`; it ignores the config. Run the tests → PASS. Then `git add -A && git commit -m "feat(adapters): composite discovery and runs, config adapters[]"`

### Task 16: Playwright adapter

**Files:**
- Create: `packages/cli/src/adapter/playwright/{index,ast,report,run,sabotage}.ts`
- Modify: `packages/cli/src/adapter/registry.ts`
- Test: `packages/cli/test/unit/playwright-report.test.ts`
- Fixtures: `packages/cli/test/fixtures/playwright-report/**`

**Interfaces:**
- `id: "playwright"`.
- `discover(root)`: a **Playwright-specific** classifier, reusing the tag/comment parser and AST utilities but not the Vitest call classifier unchanged. `test.describe(...)` is a suite, while the Vitest walker treats `describe` as an invalid modifier on `test`; `test.beforeEach`, `test.afterEach`, `test.beforeAll`, `test.afterAll`, `test.use`, `test.step`, `test.configure` and `test.extend` are hooks/config, never tests. Tests are `test`, `test.only`, `test.skip`, `test.fixme`, `test.slow`, `test.fail`; suites are `test.describe`, `test.describe.only`, `test.describe.skip`, `test.describe.serial`, `test.describe.parallel`. `runtimeId = [...suiteTitles, testTitle].join(" > ")`, skipping the top-level project suite.
- `run(checks, opts)`: spawn `node <root>/node_modules/@playwright/test/cli.js test --reporter=json` (or the project's `npx playwright test`) with `cwd: root`, `env: opts.env ?? process.env`, `timeoutMs` default `600_000`, and `PLAYWRIGHT_JSON_OUTPUT_NAME=<tmp>/report.json`. Pass the distinct check files as positional args. No shell.
- `readReports(paths, root)`: Playwright JSON first; JUnit XML second (the shared reader). A Playwright JSON report has `suites[].specs[].tests[].results[]`; map `expected` → `pass`, `unexpected` → `fail`, `flaky` → `flaky`, `skipped` → `not-run`; an unknown status is `not-run`. A file with a top-level `errors` array and no specs is a harness failure, never a green suite.
- **Multi-project merge:** Playwright emits one top-level suite per project (`chromium`, `firefox`, …). Merge results by `runtimeId` with the worst status winning: a check is `pass` only if every project passes; `not-run`/`skipped` in any project is `not-run`; `flaky` in any is `flaky`. A single project's assertion failure is proof for `applySabotage`, but a harness/timeout in any project is not proof (conservative).
- `classifyFailure`: the shared classifier; Playwright's `TimeoutError: locator…` is `timeout`, `Error: expect(...)` is `assertion`, browser-launch/config errors are `harness`.
- `applySabotage`: identical copy-and-replace shape as Vitest, but runs only the target check's file with `playwright test`; the project's `webServer` starts the app from the sandbox copy, so the sabotaged module is what the server loads. The sabotage must make the browser assertion fail; a passing test is `not-applied`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/playwright-report.test.ts
it("maps Playwright's JSON statuses and skips the project suite in the title path", () => {
  const results = mapPlaywrightJson({
    suites: [{
      title: "chromium", file: "e2e/checkout.spec.ts",
      suites: [{ title: "checkout", specs: [{ title: "completes", ok: false, file: "e2e/checkout.spec.ts", tests: [{ status: "unexpected", results: [{ status: "failed", error: { message: "Error: expect(received).toBe(expected)" } }] }] }] }],
    }],
  });
  expect(results).toEqual([
    { runtimeId: "checkout > completes", outcome: "fail", message: "Error: expect(received).toBe(expected)" },
  ]);
});

it("merges two browser projects by worst status", () => {
  const results = mapPlaywrightJson(reportWithProjects(["chromium:passed", "firefox:failed"]));
  expect(results).toEqual([{ runtimeId: "checkout > completes", outcome: "fail", message: expect.any(String) }]);
});
```

Also add a discovery test that pins `test.describe("checkout", ...)` as a suite and `test.beforeEach(...)` as a hook that is not a test; the Vitest classifier would report both as invalid shapes.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/playwright-report.test.ts` → FAIL.

- [ ] **Step 3: Implement the report mapper and the adapter**

Keep the CLI free of a Playwright dependency: the adapter spawns the project's own install and parses the JSON. A fixture with a recorded Playwright JSON pins the mapping; the real browser run is exercised in the adopter's CI, not in the invariant test suite.

- [ ] **Step 4: Run the tests, then commit**

Run: `cd packages/cli && npx vitest run test/unit/playwright-report.test.ts` → PASS. Then `git add -A && git commit -m "feat(playwright): adapter discovery, JSON reporting, sabotage runs"`

### Task 17: Vue 3 + Fastify E2E slice

**Files:**
- Create: `packages/cli/test/fixtures/vue-fastify/**`
- Modify: `docs/adopting.md` (the Vue+Fastify section)
- Test: `packages/cli/test/integration/vue-fastify.test.ts`

**Interfaces:**
- The fixture is a monorepo-shaped repo:
  - `client/` — a Vitest `jsdom` project with a component/composable test;
  - `server/` — a Vitest `node` project with a Fastify `app.inject()` test;
  - `e2e/` — a Playwright-shaped test with a recorded JSON report;
  - `vitest.config.ts` with `test.projects` for client and server;
  - `.invariant/config.yaml` with `adapters: [vitest, playwright]`;
  - `rules/checkout.yaml` and `rules/flows/checkout.yaml`, with a critical flow that has an `e2e` check.
- The server rule's seam is `server/deps.ts`; the sabotage replaces it. The client rule's seam is a composable prop/module. The e2e check is a flow-level check (no negative control; PEND-10).
- The fixture proves the composite pipeline: the Vitest adapter runs client+server checks, the Playwright adapter consumes the recorded JSON, and the flow verdict includes the e2e check.
- The docs show the real Playwright setup: `npx playwright install --with-deps chromium` in `--cli-setup`, `webServer` starting the Fastify app, `offline: true`/local base URL, and the `PLAYWRIGHT_BROWSERS_PATH` note.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/integration/vue-fastify.test.ts
it("runs Vitest client/server and a Playwright e2e check in one gate", async () => {
  const run = await runFixture("vue-fastify", {
    args: ["verify", "--reports", "playwright=playwright-report.json", "--adapter", "vitest", "--adapter", "playwright"],
  });
  expect(run.exitCode).toBe(0);
  expect(run.report?.checks.map((check) => check.check_id).sort()).toEqual([
    "checkout.completes", "checkout.server-rejects-empty-cart", "checkout.ui-shows-error",
  ]);
  expect(run.report?.flows[0]?.verdict).toBe("pass");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npm run build && npx vitest run test/integration/vue-fastify.test.ts` → FAIL.

- [ ] **Step 3: Build the fixture and the docs**

The fixture uses only the workspace's Vitest; the Playwright side is a recorded JSON report, so the test suite stays offline and browser-free. The docs carry the real-browser commands.

- [ ] **Step 4: Run the tests, then commit**

Run: `cd packages/cli && npx vitest run test/integration/vue-fastify.test.ts` → PASS. Then `git add -A && git commit -m "test(vue-fastify): client/server Vitest plus Playwright e2e in one gate"`

### Task 18: Phase 2 acceptance

**Files:**
- Modify: `docs/deployment.md`
- No production code

**Interfaces:**
- The acceptance record must contain:
  1. `npm test` green (the CLI's full suite, including the dogfood).
  2. `npm run dogfood` → exit 0, `negative_control: "executed"`, five rules `sabotage_verified: true`, class **G3** (honest).
  3. `invariant negative` → `5/5 checks proven able to fail`.
  4. A red PR with a no-op sabotage → `invariant-verdict` red, rule `blocked`, no `proven` in the comment.
  5. A red PR with a broken sabotage → `blocked` / `harness`, not a green.
  6. The scheduled run on `main` completes; a deliberate no-op staleness is caught by the schedule (if the environment allows it).
  7. The Vue+Fastify fixture's composite run is green.
- The record states the class and the residual limits verbatim.

- [ ] **Step 1: Run the full suite**

Run: `npm test` → PASS. Run: `npm run dogfood` → exit 0. Run: `node packages/cli/dist/cli.js negative --json` → 5/5.

- [ ] **Step 2: Demonstrate the red gate**

Create a branch, make `check-runner.ts`'s sabotage a no-op (return the real runner), open a PR, record the red `invariant-verdict` URL, close unmerged. Repeat with a syntax error in the sabotage to pin `harness`. Paste both URLs into `docs/deployment.md`.

- [ ] **Step 3: Record the class and the limits**

Keep `class: G3`; write: "The guarantee is executed and evidenced; it is binding only at G1/G2. G3 is procedural and is not a guarantee." List the residual limits from this plan.

- [ ] **Step 4: Commit**

`git add -A && git commit -m "docs: Phase 2 acceptance — executed negative control, red no-op and harness evidence"`

---

## Phase 3 preview (not in this plan)

Do not start these here: `invariant-scope` (advisory/blocking via `scope.mode`), `invariant status` (draft backlog and missing-seam queue), PR-comment polish beyond proof/checked, the agent skill (`skill.distribution`), and change-detection caching for the negative job. The registry schema, the verdict vocabulary and the report shape are already prepared for them.

## Self-Review

- **Spec coverage.** §6 adapter interface → Tasks 1, 3, 16. §7 negative control, isolation, no-op/harness/timeout, run policy → Tasks 2–8, 11, 13. §8 stage 6 → Tasks 4–6; stage 7 → Task 7; stage 8 → Task 9. §9.4 parallel negative job and single aggregate check → Tasks 5, 8, 13. §11 dogfood and corpus → Tasks 10, 11. §12 edge cases → Tasks 3, 4, 8, 10. §14 Phase 2 → Part A; §14 Phase 3 → preview. Part B → Tasks 15–18.
- **Contract stability.** The registry schema, the verdict vocabulary and the report shape do not change. `negative-result.json` is an internal CI artifact and gains `outcomes`. The `Adapter` interface gains the two methods the spec always named.
- **Type consistency.** `SabotageSpec`, `SabotageOutcome`, `CheckResult`, `NegativeControlRun`, `Adapter` are declared once (Tasks 1, 4) and referenced afterwards. `isProof` remains the only decision table. `runNegativeControl` is the only producer of the outcomes map.
- **Review focus.** 1 → Tasks 3, 4, 10. 2 → Task 3. 3 → Task 2. 4 → Task 7. 5 → Task 8. 6 → Task 11. 7–8 → Tasks 15–16.
- **Proportion.** Part A is the guarantee and is independently shippable. Part B is the Vue 3 + Fastify adoption slice and can follow without reopening Part A.
