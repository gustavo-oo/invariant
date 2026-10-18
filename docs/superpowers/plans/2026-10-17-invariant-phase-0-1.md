# invariant — Phase 0 + Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `invariant` CLI, registry schema/validator, tagged-check discovery, TypeScript/Vitest reference adapter, verdict roll-up, reports carrying the guarantee class, the CI workflow, `invariant doctor` and `invariant init` with a walking skeleton — so that in a real repo an `enforced` rule that has no green check blocks the merge (exit `1`) and an invalid registry blocks the gate (exit `2`).

**Architecture:** One publishable npm package (`packages/cli`, ESM, Node ≥20) implementing a forge-neutral verifier: the registry (`rules/**`) is plain files and the single source of truth; checks are ordinary tests in the project's own framework, found by tags; a thin `Adapter` interface converts discovery + run results into check verdicts; the verifier rolls verdicts up to rules and flows, writes `invariant-report.json` + a PR comment, and exits `0`/`1`/`2`. Everything the verifier depends on (discovery, execution, changed files, sabotage outcomes, forge probe) is an injected collaborator behind a module in `src/seams/` — that injection point *is* the seam the Phase 2 negative control will sabotage. `invariant doctor` computes the guarantee class (G1/G2/G3) from the environment via a forge probe and a committed baseline; the CLI itself never touches the network except inside that probe.

**Tech Stack:** TypeScript (compiled with `tsc` to ESM), Node ≥20, Vitest (CLI's own tests *and* the reference adapter), `yaml`, `ajv` (draft 2020-12), `typescript` (AST discovery). No other runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-17-invariant-design.md` (frozen at commit `82072c2`). Every section cited below refers to that document.

---

## Guarantee status: what this delivery does **not** deliver

State this at the top of any announcement about this work, and repeat it in the PR comment the tool produces.

**The complete guarantee of spec §7 does not exist until Phase 2. This plan delivers Phase 0 + Phase 1.**

| Delivered here | Not delivered here (Phase 2) |
|---|---|
| Registry schema + validator; `enforced` requires owners, ≥1 check, and a declared `seam` negative control with a declared sabotage **on every check** (spec §5.1) | Running the sabotaged check and classifying its failure |
| Discovery of tagged checks; adapter interface; TypeScript/Vitest reference adapter | `Adapter.applySabotage` / `Adapter.classifyFailure` |
| `not-run` / `flaky` are never green (`not-run` is a positive-control rule; `flaky` comes from read reports) | Producing `blocked` verdicts from a missing/unappliable seam |
| Verdict roll-up for rules and flows, exit codes, reports carrying the guarantee class | `invariant status`, `invariant-scope`, PR-comment polish, the agent skill (Phase 3) |
| The **decision table** that decides whether a sabotage outcome counts as proof (`src/verdict/proof.ts`), unit-tested | Any *producer* of sabotage outcomes other than the test harness |
| `invariant doctor`, baseline-based regression detection, class computation | — |
| Implicit immutability diff (spec §8 stage 4) and fail-closed aggregation of upstream jobs | — |

Consequences that must not be papered over anywhere in code, docs, PR comments or commit messages:

1. The report carries `guarantee.negative_control: "declared-only"` and every rule carries `sabotage_verified: false`. **No output may say a rule is proven, verified-able-to-fail, or guaranteed.** A rule is at most *checked and green*.
2. The PR comment must print a banner saying the full guarantee is not in force in this delivery.
3. `invariant-negative` (the CI job) validates *declarations* (`@seam-alias` present, sabotage file exists) and prints the not-executed notice. It must not report the negative control as executed or pass.
4. Phase 2 is a separate plan. Tasks 9, 14, 18 and 23 below are written so Phase 2 only adds an implementation of `applySabotage` + `classifyFailure` and a real producer for `SabotageOutcome`; it does not have to change the registry schema, the verdict vocabulary or the report shape.

## Open questions this plan resolves by default (spec §13 + gaps found while planning)

Each is answered by the spec's default and flagged here rather than silently decided. Nothing in this list blocks implementation; each owning task restates its line.

| # | Question | Default taken | Owning tasks |
|---|---|---|---|
| PEND-1 | Does the adapter interface in this delivery include `applySabotage`/`classifyFailure` (spec §6) even though Phase 2 owns their behaviour (§14)? | Not implemented: the interface is `id`, `discover`, `run`, `readReports`. Phase 2 adds the other two. `CheckResult.classification` exists but no producer. | 5, 8 |
| PEND-2 | Spec §9.1 says G2 requires "the agent's identity cannot write to `main`", which the CLI cannot verify. | `.invariant/config.yaml: credentialBoundary: declared \| none`, default `none`. Only an explicit human declaration can yield G2. | 2, 19 |
| PEND-3 | A discovered test must be linked to the registry's check declaration (spec §5.1 has check `id`s; §6's example shows only `@rule`/`@flow`/`@negative-control` tags). | Add a required `@check <check-id>` tag. Discovery rejects a tagged test without exactly one `@check`. Title-matching was rejected as fragile. | 5, 7 |
| PEND-4 | §6's example puts `@negative-control <path>` in the test, §5.1 also declares the sabotage in the registry. | The registry is authoritative (spec §3/§4); the tag is allowed and must match the declared path exactly, else integrity failure. | 7, 8 |
| PEND-5 | Spec §9.4 names a "reusable workflow" with four jobs, §9.3 requires the check to be named `invariant-verdict`. GitHub reports a check from `workflow_call` as `<caller job> / <called job>`, so a caller-defined required check name is fragile. | One shipped file `.github/workflows/invariant.yml` with `on: pull_request, merge_group, workflow_call`, where `invariant-verdict` is a **plain** job (so the context is exactly `invariant-verdict`). Doctor compares the required context with the context recorded in the baseline, so `workflow_call` embedders still work (they record their own context). | 16, 19 |
| PEND-6 | Spec §9.3 says `doctor` "fails" but §8's exit-code table is defined for `invariant verify` only. | Two modes: default fails when the observed class is **below the recorded baseline class** (regression gate, keeps bootstrap possible); `--strict` fails whenever the class is below G1. The class is always printed. | 19, 20 |
| PEND-7 | Merge-queue enablement is not readable through the documented classic branch-protection API. | Detect merge queue via a ruleset containing a `merge_queue` rule; when that is not observable, record `merge_queue: "unknown"` and do not downgrade on it. | 18, 19 |
| PEND-8 | §6's `applySabotage(sabotage, workdir)` needs a machine-usable alias target, but §4 puts sabotages in `.invariant/` and §5.1 declares only `seam: <text>` + `sabotage: <path>`. | The sabotage file declares `@seam-alias <repo-relative path to the seam module>`. This delivery validates the declaration; Phase 2 consumes it. No registry field is added. | 14, 23 |
| PEND-9 | §5 names the files `rules/<capability>.yaml` and `rules/flows/<flow>.yaml` but §5.1/§5.2 show lists. | Enforce exactly one flow per file with `id === basename`, and `capability === basename`. | 2 |
| PEND-10 | §5.2 does not require a negative control for flow-level checks, so a critical flow's `e2e` check can be vacuous. | Follow the spec: flow checks carry no negative control. Report the gap; requiring one would *tighten* the design, so it needs the human's call — do not add it silently. | 11, 12 |
| PEND-11 | §6 prefers reading existing JUnit/JSON output. | This delivery reads **Vitest's JSON reporter format** only. JUnit XML mapping is a Phase 2 adapter extension. | 8 |

## Global Constraints

Verbatim values from the spec. Every task inherits these.

- **Package:** ESM only, `"type": "module"`, `engines.node: ">=20"`. The CLI runs in CI **with no network and no secrets** (`invariant verify`, `validate`, `run`, `negative`, `verdict`, `init`). Only `invariant doctor`'s forge probe may use the network, and it must degrade loudly when it cannot.
- **Runtime dependencies (exactly these three):** `yaml`, `ajv` (draft 2020-12), `typescript`. Dev dependencies: `vitest`, `@types/node`.
- **TS→ESM rule:** source imports of relative modules carry the `.js` extension (`import { x } from "./model.js"`). `packages/cli/vitest.config.ts` installs a tiny `resolveId` plugin that maps `./x.js` → `./x.ts` so the same source resolves under Vitest. Never rely on extensionless imports in `src/`.
- **Rule id:** `^[A-Z][A-Z0-9]*-\d{3}$`, unique across the whole registry.
- **`criticality`:** `critical | normal`. **`status`:** `draft | enforced | deprecated`. **`layer`:** `unit | integration | e2e`.
- **`negative_control.kind`** has exactly one legal value: `seam`. No counter-example, no `why_not_seam`, no break flag, no code patch, no other kind.
- **`status: enforced`** requires: non-empty `owners`, ≥1 check, and on **every** check a `negative_control` whose `kind` is `seam`, whose `seam` is non-empty and whose `sabotage` is a repo-relative path under `.invariant/sabotages/`. A rule with no seam stays `draft`.
- **Verdicts:** `pass | fail | not-run | flaky | blocked`. `not-run` and `flaky` are **never** green. `blocked` is defined and handled by the roll-up in this delivery but has no producer until Phase 2.
- **Exit codes:** `0` all enforced rules and flows green; `1` a rule or flow is not green (or protected paths changed outside the flagged path — spec §12); `2` registry invalid, adapter failed, integrity broken, or the verifier could not run.
- **Guarantee classes:** `G1` mechanical, `G2` credential, `G3` procedural. Every report and the PR comment carry the class. No output may state G1 unless a doctor observation produced it.
- **Protected paths (spec §9.3):** `rules/`, `.invariant/`, `.github/workflows/invariant.yml`, `.github/CODEOWNERS`.
- **Required check name (spec §9.3):** `invariant-verdict`, pinned to the expected App source (`github-actions`, App id `15368` by default).
- **No clocks in artefacts:** the report contains no timestamps and no durations; volatile facts (`base`, `head`, `run_id`, `repo`, `pr`) arrive as explicit CLI inputs so golden files are byte-stable.
- **Docs in the repo are in English** (spec §5+ style); conversation with the human partner is in Portuguese.
- **The plugin never becomes a test framework** (spec §2): it discovers, runs, maps, verifies, reports. It must not own the project's tests, its config or its data.

## Review Focus

Input classes and failure modes the spec implies whose owning code is easy to get wrong. Each line's test is added to the task named in brackets.

1. **A repo with `rules/` but no `.invariant/config.yaml`** — every command must run on documented defaults, not crash and not silently require `init` to have been run. [Task 2, 15]
2. **Rule statements and rationale text containing `|`, backticks, `*` or newlines** (they are business prose, and Portuguese prose is the motivating case) — the PR comment is a Markdown table, so text must be escaped or the table silently breaks. [Task 12]
3. **CRLF line endings and a UTF-8 BOM** in `rules/*.yaml` and in tagged source files — comment-tag parsing and YAML loading must both survive, because Windows checkouts and editors add them. [Task 2, 5]
4. **Case sensitivity of ids in tags** — `@rule sales-004` must be an *orphan check* (exit 2), never a silent match, because a case-insensitive matcher turns a typo into a green gate. [Task 8]
5. **A registry with zero enforced rules** (all `draft`, empty capability file, or only flows) — exit `0`, an explicit "no enforced rules" line, and the class still printed; never a vacuous G1 claim. [Task 3, 12]

---

## File Structure

```
package.json                                   npm workspaces root (private), scripts: build/test/dogfood
tsconfig.base.json                             shared compiler options (nodenext, strict, ES2022)
README.md                                      what this is, the Phase 0/1 guarantee caveat, how to adopt
docs/adopting.md                               step-by-step adoption + the DI requirement (spec §7)
rules/self.yaml                                dogfood registry: capability `self` (SELF-001..SELF-005)
rules/flows/self-verify.yaml                   dogfood critical flow
.invariant/config.yaml                         adapter + scope/skill params + doctor + rule-change label
.invariant/sabotages/self/*.ts                 one sabotage per SELF rule (declared now, applied in Phase 2)
.invariant/protection.ruleset.json             importable GitHub ruleset
.invariant/protection-baseline.json            recorded guarantee class + required attributes
.github/CODEOWNERS                             owners for the four protected paths + itself
.github/workflows/invariant.yml                the shipped workflow, rendered for this repo (dogfood)
packages/cli/package.json                      name `invariant`, bin, engines
packages/cli/tsconfig.json                     extends base; outDir dist
packages/cli/vitest.config.ts                  the ./x.js → ./x.ts resolver plugin
packages/cli/schema/registry.schema.json       JSON Schema (draft 2020-12) for rules/** and rules/flows/**
packages/cli/schema/config.schema.json         JSON Schema for .invariant/config.yaml
packages/cli/src/cli.ts                        argv parsing + dispatch only
packages/cli/src/exit.ts                       EXIT = { GREEN:0, PRODUCT_BROKEN:1, GATE_BROKEN:2 }
packages/cli/src/fsutil.ts                     readText (BOM/CRLF tolerant), exists, glob, path guards
packages/cli/src/output.ts                     deterministic JSON writer (2-space, trailing newline) + stdout helpers
packages/cli/src/config/model.ts, load.ts      Config type, defaults, load + schema validation
packages/cli/src/registry/model.ts, load.ts    Rule/Flow/Registry types; YAML loading with line numbers
packages/cli/src/registry/validate.ts          spec §5 validation rules → Finding[]
packages/cli/src/registry/integrity.ts         orphan rules/checks, duplicate tags, tag↔registry mismatches
packages/cli/src/discovery/types.ts            DiscoveredCheck, DiscoveryResult, DiscoverySource
packages/cli/src/discovery/tags.ts             tag block parsing for the comment-tag fallback
packages/cli/src/discovery/discover.ts         orchestrates the adapter(s) over the repo root
packages/cli/src/seams/*.ts                    discovery-source, check-runner, changed-files, sabotage-source, forge-probe
packages/cli/src/context.ts                    buildVerifyContext() — the composition root (uses the seams)
packages/cli/src/adapter/api.ts                Adapter, CheckResult, RunOpts, SabotageOutcome types
packages/cli/src/adapter/registry.ts           adapter lookup by id
packages/cli/src/adapter/vitest/ast.ts         TypeScript-AST discovery of tagged tests
packages/cli/src/adapter/vitest/index.ts       discover/run/readReports
packages/cli/src/adapter/vitest/report.ts      Vitest JSON reporter → CheckResult[]
packages/cli/src/ci/event.ts                   GITHUB_EVENT_PATH → mode/base/head/pr/labels (offline)
packages/cli/src/immutability/diff.ts          protected-path diff base→head vs the rule-change flag
packages/cli/src/verdict/types.ts              Verdict, CheckVerdict, RuleVerdict, FlowVerdict, ReasonCode
packages/cli/src/verdict/proof.ts              isProof(SabotageOutcome) — the Phase 2 decision table
packages/cli/src/verdict/compute.ts            check → rule → flow roll-up
packages/cli/src/report/shape.ts               the report's TypeScript shape + schema_version
packages/cli/src/report/write.ts               report assembly (registry hashes, guarantee block)
packages/cli/src/report/comment.ts             the human Markdown table + banners (escaping)
packages/cli/src/guarantee/class.ts            computeClass(observation, credentialBoundary)
packages/cli/src/doctor/probe.ts               ForgeProbe + DoctorObservation types
packages/cli/src/doctor/github.ts              REST implementation (rulesets + classic protection)
packages/cli/src/doctor/codeowners.ts          CODEOWNERS parse/validate/coverage (last match wins)
packages/cli/src/doctor/checks.ts              spec §9.3 items 1–7 + the check-name ambiguity check
packages/cli/src/doctor/baseline.ts            baseline read/write/compare
packages/cli/src/negative/declared.ts          stage 6 declaration checks (@seam-alias, file exists)
packages/cli/src/commands/*.ts                 validate, run, negative, verdict, verify, doctor, init
packages/cli/src/assets/**                     everything `invariant init` writes (templates + walking skeleton)
packages/cli/test/unit/**                      vitest unit tests
packages/cli/test/integration/**               fixture-driven tests that spawn the built CLI
packages/cli/test/self/*.test.ts               the SELF-001..005 dogfood checks (tagged)
packages/cli/test/fixtures/<name>/**           hostile corpus inputs
packages/cli/test/golden/<name>/**(report.json, comment.md, exit.txt)  pinned outputs
packages/cli/test/helpers/{run-cli,fixture,goldens,stub-adapter,fake-probe,registry}.ts
```

Commands, in full (this is the CLI surface other tasks refer to):

```
invariant validate  [--root <dir>] [--base <ref>] [--event <path>] [--json] [--out <file>]
invariant run       [--root <dir>] [--adapter <id>] [--reports <file>]... [--json] [--out <file>]
invariant negative  [--root <dir>] [--json] [--out <file>]
invariant verdict   --inputs <dir> [--job-status <job>=<result>]... [--doctor-result <file>]
                    [--repo <owner/name>] [--run-id <id>] [--base <ref>] [--head <sha>]
                    [--out <file>] [--comment <file>] [--json]
invariant verify    [--root <dir>] [--adapter <id>] [--base <ref>] [--head <sha>] [--event <path>]
                    [--doctor-result <file>] [--repo <owner/name>] [--run-id <id>]
                    [--out <file>] [--comment <file>] [--json]
invariant doctor    [--root <dir>] [--record] [--strict] [--check <name>] [--json] [--out <file>]
invariant init      [dir] --owner <@handle> [--adapter <id>] [--cli-setup <cmd>] [--invariant-cmd <cmd>]
```

---

## Tasks

Tasks 1–13 are the Phase 0 deliverables, tasks 14–24 the Phase 1 deliverables, task 25 is the GitHub deployment. Do them in order: every task's Interfaces block assumes the ones before it.

### Task 1: Package skeleton, CLI entry, exit codes

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`, `README.md`
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/vitest.config.ts`
- Create: `packages/cli/src/cli.ts`, `packages/cli/src/exit.ts`, `packages/cli/src/output.ts`
- Test: `packages/cli/test/unit/cli.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `EXIT` (`{ GREEN: 0, PRODUCT_BROKEN: 1, GATE_BROKEN: 2 }`), `type ExitCode = 0 | 1 | 2`; `runCli(argv: string[], io?: { cwd: string; stdout: (s: string) => void; stderr: (s: string) => void }): Promise<ExitCode>`; `stringifyJson(value: unknown): string`.

- [ ] **Step 1: Create the workspace and test config**

Root `package.json`: `{ "name": "invariant-monorepo", "private": true, "type": "module", "workspaces": ["packages/*"], "engines": { "node": ">=20" }, "scripts": { "build": "npm run build -w packages/cli", "test": "npm test -w packages/cli", "dogfood": "npm run build && node packages/cli/dist/cli.js verify", "test:update": "npm test -w packages/cli -- --update" } }`.

`tsconfig.base.json`: `module: "nodenext"`, `moduleResolution: "nodenext"`, `target: "es2022"`, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `verbatimModuleSyntax: true`, `declaration: false`.

`packages/cli/package.json`: `{ "name": "invariant", "type": "module", "version": "0.1.0", "bin": { "invariant": "dist/cli.js" }, "engines": { "node": ">=20" }, "files": ["dist", "schema", "assets"], "dependencies": { "ajv": "^8", "typescript": "^5", "yaml": "^2" }, "devDependencies": { "vitest": "^3", "@types/node": "^22" }, "scripts": { "build": "tsc -p tsconfig.json", "test": "npm run build && vitest run" } }`. Use the latest 8.x/5.x/2.x/3.x ranges the installed registry resolves; record the resolved versions in the commit message.

`packages/cli/tsconfig.json`: extends `../../tsconfig.base.json`, `outDir: "dist"`, `rootDir: "src"`, `include: ["src/**/*.ts"]`.

`packages/cli/vitest.config.ts` — the `.js → .ts` resolver, required because `tsc` output keeps the `.js` specifiers:

```ts
import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

const tsFromJs: Plugin = {
  name: "invariant-ts-from-js",
  enforce: "pre",
  resolveId(source, importer) {
    if (!importer || !source.startsWith("./") && !source.startsWith("../")) return;
    if (!source.endsWith(".js")) return;
    const candidate = path.resolve(path.dirname(importer), source.slice(0, -3) + ".ts");
    if (existsSync(candidate)) return candidate;
  },
};

export default defineConfig({
  plugins: [tsFromJs],
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
```

`.gitignore`: `node_modules/`, `dist/`, `invariant-report.json`, `invariant-comment.md`, `*.tsbuildinfo`.

- [ ] **Step 2: Write the failing test**

```ts
// packages/cli/test/unit/cli.test.ts
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { EXIT } from "../../src/exit.js";

describe("cli", () => {
  it("prints the version and exits 0", async () => {
    const out: string[] = [];
    const code = await runCli(["--version"], { cwd: process.cwd(), stdout: (s) => out.push(s), stderr: () => {} });
    expect(code).toBe(EXIT.GREEN);
    expect(out.join("")).toMatch(/^invariant \d+\.\d+\.\d+\n$/);
  });

  it("prints usage and exits 2 for an unknown subcommand", async () => {
    const err: string[] = [];
    const code = await runCli(["status"], { cwd: process.cwd(), stdout: () => {}, stderr: (s) => err.push(s) });
    expect(code).toBe(EXIT.GATE_BROKEN);
    expect(err.join("")).toContain("unknown subcommand: status");
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/cli.test.ts`
Expected: FAIL — cannot resolve `../../src/cli.js`.

- [ ] **Step 4: Implement `exit.ts`, `cli.ts`, `output.ts`**

`exit.ts` exports the `EXIT` object and `ExitCode`. `cli.ts` exports `runCli` which: handles `--version` (reads the package version from `../package.json` relative to the built `dist/`), `--help`/`-h` (usage for the command table in File Structure), dispatches known subcommands to `commands/*.js` (each returns an `ExitCode`), and for an unknown or missing subcommand writes `unknown subcommand: <name>` + usage to stderr and returns `EXIT.GATE_BROKEN`. `output.ts` exports `stringifyJson` (`JSON.stringify(value, null, 2) + "\n"`) and `writeOut(path | null, text)` where `null` means stdout.

- [ ] **Step 5: Run the tests, then commit**

Run: `cd packages/cli && npx vitest run test/unit/cli.test.ts` → PASS.
Then: `git add -A && git commit -m "feat(cli): package skeleton, ESM build, exit codes, dispatch"`

### Task 2: Registry model, JSON Schema and loader

**Files:**
- Create: `packages/cli/schema/registry.schema.json`, `packages/cli/schema/config.schema.json`
- Create: `packages/cli/src/registry/model.ts`, `packages/cli/src/registry/load.ts`
- Create: `packages/cli/src/config/model.ts`, `packages/cli/src/config/load.ts`, `packages/cli/src/fsutil.ts`
- Create: `packages/cli/test/helpers/fixture.ts` (`makeTmpRepo`)
- Test: `packages/cli/test/unit/registry-load.test.ts`

**Interfaces:**
- Consumes: `EXIT`, `fsutil`.
- Produces: types `Criticality`, `RuleStatus`, `CheckLayer`, `NegativeControl`, `CheckDecl`, `Rule`, `FlowStep`, `FlowCheckDecl`, `Flow`, `Registry`, `SourceRef = { file: string; line: number }`; `loadRegistry(root: string): Promise<{ registry: Registry; findings: Finding[] }>`; `type Finding = { code: string; message: string; file: string; line?: number; ruleId?: string; flowId?: string; checkId?: string }`; `type Config` and `loadConfig(root: string): Promise<{ config: Config; findings: Finding[] }>`.

- [ ] **Step 1: Write the JSON Schemas**

`registry.schema.json` is draft 2020-12 with two top-level definitions: a capability document `{ capability: string (^[a-z][a-z0-9-]*$), rules: Rule[] }` and a flow document `{ flows: Flow[] }` — the loader decides which applies from the file path. `Rule` requires `id`, `statement`, `rationale`, `criticality`, `status`, `checks` and allows `owners`, `paths`, `replaced_by`, `retired`. `CheckDecl` requires `id`, `layer` and allows `negative_control`. `NegativeControl` requires `kind` (`const: "seam"`), `seam` (minLength 1) and `sabotage` (pattern `^\.invariant/sabotages/[A-Za-z0-9._/-]+\.(ts|js|mjs|py|rb|go|java|cs)$`). `Flow` requires `id`, `name`, `owner`, `criticality`, `steps`, `checks` and allows `paths`. `FlowStep` requires `id`, `name`, `rules` (minItems 1). `FlowCheckDecl` requires `id`, `layer`. Set `additionalProperties: false` everywhere.

`config.schema.json`: `{ adapter: string (default "vitest"), scope: { mode: "advisory"|"blocking" }, skill: { distribution: "manifest-only"|"opencode"|"both" }, doctor: { apiUrl: string, tokenEnv: string, expectedAppId: integer }, ruleChange: { label: string }, credentialBoundary: "declared"|"none", protectedPaths: string[] }`, all optional.

Reference each file from the other side: the capability document `$ref`s `Rule`, and `rules/*.yaml` files are validated against the capability document while `rules/flows/*.yaml` are validated against the flow document.

- [ ] **Step 2: Write the failing test**

```ts
// packages/cli/test/unit/registry-load.test.ts
import { describe, expect, it } from "vitest";
import { loadRegistry } from "../../src/registry/load.js";
import { loadConfig } from "../../src/config/load.js";
import { makeTmpRepo } from "../helpers/fixture.js";

describe("loadRegistry", () => {
  it("reads capabilities and flows with line numbers", async () => {
    const root = await makeTmpRepo({
      "rules/sales.yaml": `capability: sales\nrules:\n  - id: SALES-004\n    statement: "A sale MUST NOT complete when stock is insufficient."\n    rationale: "Prevents overselling."\n    criticality: critical\n    status: enforced\n    owners: [team-commerce]\n    checks:\n      - id: sales.rejects-insufficient-stock\n        layer: integration\n        negative_control:\n          kind: seam\n          seam: "buildApp({ stockPolicy })"\n          sabotage: .invariant/sabotages/sales/stock.ts\n`,
    });
    const { registry, findings } = await loadRegistry(root);
    expect(findings).toEqual([]);
    expect(registry.rules).toHaveLength(1);
    expect(registry.rules[0]?.id).toBe("SALES-004");
    expect(registry.rules[0]?.checks[0]?.negativeControl?.sabotage).toBe(".invariant/sabotages/sales/stock.ts");
    expect(registry.rules[0]?.source).toEqual({ file: "rules/sales.yaml", line: 3 });
  });

  it("splits CRLF and strips a UTF-8 BOM (review focus 3)", async () => {
    const root = await makeTmpRepo({ "rules/sales.yaml": "\uFEFFcapability: sales\r\nrules: []\r\n" });
    const { findings } = await loadRegistry(root);
    expect(findings).toEqual([]);
  });

  it("rejects a capability file whose name does not match its capability (PEND-9)", async () => {
    const root = await makeTmpRepo({ "rules/sales.yaml": "capability: billing\nrules: []\n" });
    const { findings } = await loadRegistry(root);
    expect(findings.map((f) => f.code)).toEqual(["registry.file_capability_mismatch"]);
  });
});

describe("loadConfig", () => {
  it("applies documented defaults when .invariant/config.yaml is absent (review focus 1)", async () => {
    const root = await makeTmpRepo({ "rules/sales.yaml": "capability: sales\nrules: []\n" });
    const { config, findings } = await loadConfig(root);
    expect(findings).toEqual([]);
    expect(config.adapter).toBe("vitest");
    expect(config.scope.mode).toBe("advisory");
    expect(config.skill.distribution).toBe("manifest-only");
    expect(config.credentialBoundary).toBe("none");
    expect(config.ruleChange.label).toBe("invariant:rule-change");
    expect(config.doctor.expectedAppId).toBe(15368);
    expect(config.protectedPaths).toEqual(["rules/", ".invariant/", ".github/workflows/invariant.yml", ".github/CODEOWNERS"]);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/registry-load.test.ts`
Expected: FAIL — `src/registry/load.js` not found.

- [ ] **Step 4: Implement the loader**

`fsutil.ts`: `readText(file)` strips a leading BOM and normalizes CRLF/CR to LF; `listFiles(root, glob)` walks the tree (no dependency — implement a small matcher supporting `**`, `*`, `?`); `assertInsideRepo(root, rel)` rejects absolute paths and paths escaping the root.

`load.ts`: reads `rules/*.yaml` as capability documents and `rules/flows/*.yaml` as flow documents with `parseDocument(text, { lineCounter })` from `yaml`; converts camelCase stays as written in YAML (`negative_control` → `negativeControl`, `replaced_by` → `replacedBy`); records `source.file` repo-relative and `source.line` from the line counter of the node's first key; validates each document with `Ajv2020` (`import Ajv2020 from "ajv/dist/2020.js"`) and maps each `ajv` error to a `Finding` with code `registry.schema`, using `instancePath` for the message. Missing `rules/` directory is not an error — it yields an empty registry. Enforce PEND-9 naming here (`registry.file_capability_mismatch`, `registry.flow_file_id_mismatch`) since it depends on the file name.

`config/load.ts`: absent file → documented defaults; present file → schema validation and `Finding` code `config.schema`.

Also create `packages/cli/test/helpers/fixture.ts` exporting `makeTmpRepo(files: Record<string, string>): Promise<string>`: writes the given repo-relative files under `os.tmpdir()` (creating directories) and returns the **realpath** of the temporary root, so macOS's `/private/var/...` prefix never leaks into an assertion.

- [ ] **Step 5: Run the tests, then commit**

Run: `cd packages/cli && npx vitest run test/unit/registry-load.test.ts` → PASS.
Then: `git add -A && git commit -m "feat(registry): JSON Schema, model and BOM/CRLF-tolerant loader"`

### Task 3: Registry validation (spec §5) and `invariant validate`

**Files:**
- Create: `packages/cli/src/registry/validate.ts`, `packages/cli/src/commands/validate.ts`
- Create: `packages/cli/test/helpers/registry.ts` (the shared `capability`, `flow`, `codesForFlow` builders)
- Test: `packages/cli/test/unit/registry-validate.test.ts`, `packages/cli/test/integration/validate-cli.test.ts`
- Create fixtures: `packages/cli/test/fixtures/invalid-registry/**`, `packages/cli/test/fixtures/empty-registry/**`, goldens under `packages/cli/test/golden/{invalid-registry,empty-registry}/`

**Interfaces:**
- Consumes: `Registry`, `Config`, `Finding`, `loadRegistry`, `loadConfig`.
- Produces: `validateRegistry(registry: Registry, opts: { cwd: string; config: Config }): Finding[]`; `invariant validate` returning `EXIT.GREEN` / `EXIT.GATE_BROKEN`; test helper `runFixture(name, opts?)` and golden helpers in `test/helpers/`, plus the registry-YAML builders `capability(id, overrides?)`, `flow(overrides?)` and `codesForFlow(yaml)` in `test/helpers/registry.ts` (used again by Tasks 7, 14 and 23).

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/registry-validate.test.ts
import { describe, expect, it } from "vitest";
import { validateRegistry } from "../../src/registry/validate.js";
import { loadRegistry } from "../../src/registry/load.js";
import { DEFAULT_CONFIG } from "../../src/config/model.js";
import { makeTmpRepo } from "../helpers/fixture.js";
import { capability, codesForFlow, flow } from "../helpers/registry.js";
import type { Finding } from "../../src/registry/validate.js";

// capability(id, overrides) returns the YAML text of a one-rule capability document.
const codes = async (yaml: string) => {
  const { registry } = await loadRegistry(await makeTmpRepo({ "rules/sales.yaml": yaml }));
  return validateRegistry(registry, { cwd: "/x", config: DEFAULT_CONFIG }).map((f) => f.code).sort();
};

describe("validateRegistry (spec §5.1)", () => {
  it("rejects an id that does not match ^[A-Z][A-Z0-9]*-\\d{3}$", async () => {
    expect(await codes(capability("SALES-4"))).toContain("registry.invalid_id");
  });
  it("rejects an enforced rule with no check", async () => {
    expect(await codes(capability("SALES-004", { checks: [] }))).toContain("registry.enforced_without_check");
  });
  it("rejects an enforced rule with no owners", async () => {
    expect(await codes(capability("SALES-004", { owners: [] }))).toContain("registry.enforced_without_owners");
  });
  it("rejects any negative_control kind other than seam", async () => {
    expect(await codes(capability("SALES-004", { kind: "counter-example" }))).toContain("registry.negative_control_kind_unsupported");
  });
  it("rejects a sabotage path outside .invariant/sabotages/", async () => {
    expect(await codes(capability("SALES-004", { sabotage: "scripts/break-it.ts" }))).toContain("registry.sabotage_path_invalid");
  });
  it("rejects a duplicate check id across the registry", async () => {
    expect(await codes(capability("SALES-004", { checkId: "sales.a" }))).toContain("registry.duplicate_check_id");
  });
  it("rejects a deprecated rule with no replacement", async () => {
    expect(await codes(capability("SALES-004", { status: "deprecated", checks: [] }))).toContain("registry.deprecated_without_replacement");
  });
  it("accepts a draft rule with no checks and no seam (spec §5.3)", async () => {
    expect(await codes(capability("SALES-004", { status: "draft", checks: [] }))).toEqual([]);
  });
  it("accepts a zero-enforced-rule registry and reports no findings (review focus 5)", async () => {
    expect(await codes("capability: sales\nrules: []\n")).toEqual([]);
  });
});

describe("validateRegistry (spec §5.2)", () => {
  it("requires an e2e check on a critical flow", async () => {
    expect(await codesForFlow(flow({ criticality: "critical", layer: "integration" }))).toContain("flow.critical_without_e2e");
  });
  it("requires a referenced rule to exist and each step to carry one", async () => {
    expect(await codesForFlow(flow({ stepRules: ["SALES-999"] }))).toContain("flow.unknown_rule");
    expect(await codesForFlow(flow({ stepRules: [] }))).toContain("flow.step_without_rules");
  });
  it("requires unique step ids per flow", async () => {
    expect(await codesForFlow(flow({ stepIds: ["s1", "s1"] }))).toContain("flow.duplicate_step_id");
  });
});
```

`capability(id, overrides)`, `flow(overrides)` and `codesForFlow(yaml)` live in `test/helpers/registry.ts` (created in this task): they build the YAML text and load it through `loadRegistry` (a second capability/flow file as needed), so every assertion above is real code with the spec's exact values. They are shared, not test-local, because Tasks 7, 14 and 23 reuse them. Record the full set of codes the spec's table requires as you write them; the list is the spec's §5.1/§5.2 rules, one per test.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/registry-validate.test.ts` → FAIL.

- [ ] **Step 3: Implement `validateRegistry`**

One function, findings only, no I/O. Codes and rules, in this order: `registry.invalid_id` (spec §5.1 regex), `registry.duplicate_rule_id`, `registry.missing_statement`, `registry.missing_rationale`, `registry.duplicate_check_id` (across the whole registry), `registry.enforced_without_check`, `registry.enforced_without_owners`, `registry.enforced_without_negative_control` (one per check), `registry.negative_control_kind_unsupported` (any `kind` other than `seam`), `registry.sabotage_path_invalid`, `registry.deprecated_without_replacement`, flow codes `flow.duplicate_flow_id`, `flow.unknown_rule`, `flow.step_without_rules`, `flow.duplicate_step_id`, `flow.critical_without_e2e` (a `critical` flow needs ≥1 check with `layer: e2e`). A `deprecated` rule satisfies the replacement requirement with `replaced_by` pointing at an existing rule or `retired: true`. This single function also carries the Phase 1 requirement that `enforced` implies seam sabotage (spec §5.1) — a partial validator would create exactly the weak-proof state the design forbids.

- [ ] **Step 4: Implement the `validate` command and its exit codes**

`commands/validate.ts`: `loadConfig` → `loadRegistry` → `validateRegistry`; any finding (including loader findings) → print each as `<file>:<line> <code> <message>`, return `EXIT.GATE_BROKEN`, and emit **no** rule verdicts anywhere. Add `--json` (a `{ findings: Finding[] }` document) and `--out <file>`. `--base` + `--event` are accepted and ignored in this task (Task 14 wires immutability) — document that in the command's help text.

- [ ] **Step 5: Add the fixture + golden integration test**

Create `test/helpers/run-cli.ts` exporting `spawnCli(args: string[], opts: { cwd: string }): Promise<{ exitCode: ExitCode; stdout: string; stderr: string }>` (spawns `node <pkg>/dist/cli.js`, never a shell) and `runFixture(name: string, opts?: { args?: string[] }): Promise<FixtureRun>` where `FixtureRun = { exitCode: ExitCode; stdout: string; stderr: string; report: Report | null; comment: string | null; root: string }`. `runFixture` copies `test/fixtures/<name>` into a fresh temp dir (never mutating the fixture), runs the CLI there, and parses `invariant-report.json` / `invariant-comment.md` when present. Create `test/helpers/goldens.ts` exporting `expectGolden(name: string, value: unknown, file: string)` (compares with `test/golden/<name>/<file>`, rewriting the file when `UPDATE_GOLDENS=1`, and always failing on a mismatch with a diff) and `normalizeReport(value: Report): Report` (replaces `tool.version` with `"<version>"`; the report is otherwise deterministic by construction).

Then `test/integration/validate-cli.test.ts`:

```ts
it("exits 2 and emits no verdicts for an invalid registry", async () => {
  const run = await runFixture("invalid-registry");
  expect(run.exitCode).toBe(2);
  await expectGolden("invalid-registry", run.stderr, "stderr.txt");
});
it("exits 0 for a registry with no enforced rules and says so", async () => {
  const run = await runFixture("empty-registry");
  expect(run.exitCode).toBe(0);
  expect(run.stdout).toContain("0 enforced rules");
});
```

- [ ] **Step 6: Run the tests, then commit**

Run: `cd packages/cli && npm test` → PASS. Then `git add -A && git commit -m "feat(registry): §5 validation rules, validate command, exit 2"`

### Task 4: Discovery types, comment-tag parsing, `DiscoverySource` seam

**Files:**
- Create: `packages/cli/src/discovery/types.ts`, `packages/cli/src/discovery/tags.ts`, `packages/cli/src/discovery/discover.ts`
- Create: `packages/cli/src/seams/discovery-source.ts`
- Test: `packages/cli/test/unit/discovery-tags.test.ts`

**Interfaces:**
- Consumes: `Config`, `fsutil`.
- Produces: `DiscoveredCheck = { checkId: string; rules: string[]; flows: FlowRef[]; negativeControl?: string; testName: string; file: string; line: number; frameworkId: string; runtimeId: string }`; `FlowRef = { flow: string; step?: string }`; `DiscoveryError = { file: string; line?: number; message: string }`; `DiscoveryResult = { checks: DiscoveredCheck[]; errors: DiscoveryError[] }`; `interface DiscoverySource { id: string; discover(root: string): Promise<DiscoveryResult> }`; `parseTagBlock(lines: string[], index: number): { tags: RawTags; consumed: number } | null`; `createDiscoverySource(config: Config): DiscoverySource`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/discovery-tags.test.ts
import { describe, expect, it } from "vitest";
import { parseTagBlock } from "../../src/discovery/tags.js";

describe("parseTagBlock", () => {
  it("reads the four tags from a contiguous comment block, ignoring the rest", () => {
    const lines = [
      "// @check sales.rejects-insufficient-stock",
      "// @rule SALES-004",
      "// @flow checkout/s2",
      "// @negative-control .invariant/sabotages/sales/stock.ts",
      'test("sale is rejected when stock is insufficient", async () => {',
    ];
    expect(parseTagBlock(lines, 0)?.tags).toEqual({
      checks: ["sales.rejects-insufficient-stock"],
      rules: ["SALES-004"],
      flows: [{ flow: "checkout", step: "s2" }],
      negativeControl: [".invariant/sabotages/sales/stock.ts"],
    });
  });

  it("returns null on a blank line or a non-tag comment between tags (no floating tags)", () => {
    expect(parseTagBlock(["// @rule SALES-004", "", "// @check x.y"], 0)).toBeNull();
  });

  it("stops at a non-tag comment line and leaves it for the caller", () => {
    const lines = ["/* @rule SALES-004 */", "/* explanation */", "test("];
    expect(parseTagBlock(lines, 0)?.consumed).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/discovery-tags.test.ts` → FAIL.

- [ ] **Step 3: Implement `tags.ts` and the seam**

`tags.ts` scans from `index` over contiguous comment lines (`//`, `/* … */`, `#` for non-JS stacks) collecting `@check`, `@rule`, `@flow` (`<flow>` or `<flow>/<step>`), `@negative-control`. A tag repeated on the same test is allowed (it produces a list) — duplicates *across* tests are integrity findings (Task 8). A same-file tag block not immediately followed by a test call is a floating tag: the caller turns it into a `DiscoveryError`. `readText` already removed BOM/CRLF (review focus 3).

`seams/discovery-source.ts` exports `createDiscoverySource(config: Config): DiscoverySource` — it selects the adapter by `config.adapter` from `src/adapter/registry.js` (Task 7) and delegates. This module is a **seam**: the Phase 2 negative control will alias it (PEND-8).

- [ ] **Step 4: Run the tests, then commit**

Run: `cd packages/cli && npx vitest run test/unit/discovery-tags.test.ts` → PASS. Then `git add -A && git commit -m "feat(discovery): tag model, comment-tag fallback parser, discovery seam"`

### Task 5: Vitest AST discovery

**Files:**
- Create: `packages/cli/src/adapter/api.ts`, `packages/cli/src/adapter/registry.ts`, `packages/cli/src/adapter/vitest/ast.ts`, `packages/cli/src/adapter/vitest/index.ts`
- Test: `packages/cli/test/unit/vitest-discover.test.ts`

**Interfaces:**
- Consumes: `DiscoveredCheck`, `DiscoveryResult`, `parseTagBlock`.
- Produces: `interface Adapter { id: string; discover(root: string): Promise<DiscoveryResult>; run(checks: DiscoveredCheck[], opts: RunOpts): Promise<CheckResult[]>; readReports(paths: string[], root: string): Promise<CheckResult[] | null> }`; `RunOpts = { root: string; env?: Record<string, string> }`; `CheckResult = { runtimeId: string; outcome: "pass" | "fail" | "not-run" | "flaky"; classification?: "assertion" | "harness" | "timeout"; message?: string }`; `adapters(): Adapter[]`, `findAdapter(id: string): Adapter | undefined`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/vitest-discover.test.ts
import { describe, expect, it } from "vitest";
import { findAdapter } from "../../src/adapter/registry.js";
import { makeTmpRepo } from "../helpers/fixture.js";

const vitest = findAdapter("vitest")!;

it("discovers tagged tests through the AST with suite-qualified runtime ids", async () => {
  const root = await makeTmpRepo({
    "src/sale.test.ts": `
      import { describe, test } from "vitest";
      describe("sales", () => {
        // @check sales.rejects-insufficient-stock
        // @rule SALES-004
        // @flow checkout/s2
        test("rejects insufficient stock", () => {});
      });
    `,
  });
  const { checks, errors } = await vitest.discover(root);
  expect(errors).toEqual([]);
  expect(checks).toEqual([
    {
      checkId: "sales.rejects-insufficient-stock",
      rules: ["SALES-004"],
      flows: [{ flow: "checkout", step: "s2" }],
      testName: "rejects insufficient stock",
      file: "src/sale.test.ts",
      line: 7,
      frameworkId: "vitest",
      runtimeId: "sales > rejects insufficient stock",
    },
  ]);
});

it("reports a floating tag block as an error instead of guessing", async () => {
  const root = await makeTmpRepo({ "src/x.test.ts": "// @rule SALES-004\n\nconst x = 1;\n" });
  const { checks, errors } = await vitest.discover(root);
  expect(checks).toEqual([]);
  expect(errors[0]?.message).toContain("tag block is not attached to a test call");
});

it("reports an unparseable file as an error (never a silent skip)", async () => {
  const root = await makeTmpRepo({ "src/bad.test.ts": "test( " });
  const { errors } = await vitest.discover(root);
  expect(errors[0]?.message).toContain("could not parse");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/vitest-discover.test.ts` → FAIL.

- [ ] **Step 3: Implement AST discovery**

`vitest/ast.ts` uses `import ts from "typescript"` and `ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)`. Walk for `CallExpression` whose expression text is one of `test|it|test.skip|it.skip|test.only|test.todo|describe` (nested `describe` titles form the suite path). For each test call: take `ts.getLeadingCommentRanges(text, node.getFullStart())` — the *attached* leading comments are the AST-first answer, and `parseTagBlock` on the comment text is the fallback for stacks where the AST gives nothing. `line` is the **test call's** line (`sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1`), which is what the test above pins; `runtimeId` = `[...suiteTitles, testTitle].join(" > ")`. A `test.todo`/`test.skip` is still discovered (it becomes `not-run` at run time). Discovery walks files matched by the project's `**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts}` and skips `node_modules`, `dist`, `.git`. Any `ts.SyntaxKind` diagnostic → a `DiscoveryError` (never a skip).

- [ ] **Step 4: Run the tests, then commit**

Run: `cd packages/cli && npx vitest run test/unit/vitest-discover.test.ts` → PASS. Then `git add -A && git commit -m "feat(adapter): TypeScript/Vitest AST discovery, adapter registry"`

### Task 6: Vitest adapter `run` + `readReports`

**Files:**
- Create: `packages/cli/src/adapter/vitest/run.ts`, `packages/cli/src/adapter/vitest/report.ts`
- Test: `packages/cli/test/unit/vitest-run.test.ts`

**Interfaces:**
- Consumes: `Adapter`, `CheckResult`, `DiscoveredCheck`.
- Produces: `runChecks(checks: DiscoveredCheck[], opts: RunOpts): Promise<CheckResult[]>`; `mapVitestJson(json: unknown): CheckResult[]`; `readReports(paths, root)` returning `null` when no readable report exists.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/vitest-run.test.ts
import { describe, expect, it } from "vitest";
import { mapVitestJson } from "../../src/adapter/vitest/report.js";
import { runChecks } from "../../src/adapter/vitest/run.js";
import { makeTmpRepo } from "../helpers/fixture.js";

it("classifies pass, fail and retried-pass(flaky) from the reporter payload", () => {
  expect(mapVitestJson({
    testResults: [{ name: "src/a.test.ts", assertionResults: [
      { fullName: "sales > rejects insufficient stock", status: "passed", retryCount: 0 },
      { fullName: "sales > blocks negative quantity", status: "failed", retryCount: 0, failureMessages: ["expected 409 to be 200"] },
      { fullName: "sales > is idempotent", status: "passed", retryCount: 2 },
    ]}],
  })).toEqual([
    { runtimeId: "sales > rejects insufficient stock", outcome: "pass" },
    { runtimeId: "sales > blocks negative quantity", outcome: "fail", message: "expected 409 to be 200" },
    { runtimeId: "sales > is idempotent", outcome: "flaky" },
  ]);
});

it("marks a declared check absent from the report as not-run", async () => {
  const root = await makeTmpRepo({
    "src/sale.test.ts": `import { test } from "vitest";\n// @check sales.a\n// @rule SALES-004\ntest("a", () => {});\n// @check sales.b\n// @rule SALES-004\ntest.skip("b", () => {});\n`,
  });
  const results = await runChecks(
    [
      { checkId: "sales.a", rules: ["SALES-004"], flows: [], testName: "a", file: "src/sale.test.ts", line: 4, frameworkId: "vitest", runtimeId: "a" },
      { checkId: "sales.b", rules: ["SALES-004"], flows: [], testName: "b", file: "src/sale.test.ts", line: 7, frameworkId: "vitest", runtimeId: "b" },
      { checkId: "sales.c", rules: ["SALES-004"], flows: [], testName: "c", file: "src/nothing.test.ts", line: 1, frameworkId: "vitest", runtimeId: "c" },
    ],
    { root },
  );
  expect(results.map((r) => [r.runtimeId, r.outcome])).toEqual([["a", "pass"], ["b", "not-run"], ["c", "not-run"]]);
});

it("pins the runtimeId separator against a real nested run", async () => {
  const root = await makeVitestRepo({ "package.json": "{}", "src/n.test.ts": `import { describe, expect, test } from "vitest";\ndescribe("sales", () => {\n  describe("stock", () => {\n    test("rejects", () => { expect(1).toBe(1); });\n  });\n});\n` });
  const [check] = (await findAdapter("vitest")!.discover(root)).checks;
  const results = await runChecks([check!], { root });
  expect(results).toEqual([{ runtimeId: check!.runtimeId, outcome: "pass" }]);
});
```

Confirm the exact reporter field for the retry count and the exact `fullName` join separator on the pinned Vitest version while writing this test (Vitest 3's JSON reporter emits `retryCount` and joins suite titles with `" > "`); if either differs, adopt the observed value in `vitest/ast.ts` / `report.ts` and state the evidence in the commit message. If `retryCount` is genuinely absent, derive flakiness from `readReports` only and record that `runChecks` cannot report `flaky`.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/vitest-run.test.ts` → FAIL.

- [ ] **Step 3: Implement `runChecks` and `mapVitestJson`**

`runChecks`: spawn `node <root>/node_modules/vitest/vitest.mjs run --reporter=json --outputFile=<tmp> --retry=0 <files...>` via `child_process.execFile` with `cwd: opts.root`, no shell, `env` from `opts.env`. Distinct files from the given checks (one invocation). Then `mapVitestJson` over the JSON, and for every input check whose `runtimeId` is absent from the mapped results emit `{ runtimeId, outcome: "not-run" }`. A non-zero vitest exit is expected when checks fail — read the report first, and only if the report file is missing or unparseable return exit `2` (Task 7 turns that into `EXIT.GATE_BROKEN`). Never enable retries: `--retry=0` in our own runs, so a flaky test simply fails (spec §6, "no silent retry-until-green"); `flaky` comes from report mapping only. `readReports` reads Vitest JSON files and returns `null` if none of the paths exist or parse, so the caller re-runs (spec §6's "read before re-run"); JUnit is out of scope here (PEND-11).

- [ ] **Step 4: Run the tests, then commit**

Run: `cd packages/cli && npx vitest run test/unit/vitest-run.test.ts` → PASS. Then `git add -A && git commit -m "feat(adapter): vitest run + readReports, not-run/flaky classification"`

### Task 7: `invariant run` (spec §8 stage 5)

**Files:**
- Create: `packages/cli/src/commands/run.ts`, `packages/cli/src/seams/check-runner.ts`
- Test: `packages/cli/test/integration/run-cli.test.ts`
- Create fixtures: `test/fixtures/not-run-check/**`, `test/golden/not-run-check/**`

**Interfaces:**
- Consumes: `findAdapter`, `runChecks`, `loadRegistry`.
- Produces: `createCheckRunner(adapter: Adapter): CheckRunner` where `CheckRunner = { run(checks: DiscoveredCheck[], opts: RunOpts): Promise<CheckResult[] | { error: string }> }`; `invariant run` returning `EXIT.GREEN` when every executed check passes, `EXIT.PRODUCT_BROKEN` when a check fails / is `not-run` / is `flaky`, `EXIT.GATE_BROKEN` when the adapter cannot run.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/integration/run-cli.test.ts
it("exits 1 when an enforced rule's check never runs", async () => {
  const run = await runFixture("not-run-check", { args: ["run"] });
  expect(run.exitCode).toBe(1);
  expect(run.stdout).toContain("not-run");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npm run build && npx vitest run test/integration/run-cli.test.ts` → FAIL (`run` is not a known subcommand).

- [ ] **Step 3: Implement the runner seam and the command**

`seams/check-runner.ts` exports `createCheckRunner(adapter)` — a passthrough with an error union. This is the seam that SELF-001's sabotage will replace (Task 23). `commands/run.ts`: load config + registry, discover through `createDiscoverySource`, run through `createCheckRunner`, print one line per check (`<checkId> <runtimeId> <outcome>`), exit per the rules above. `--reports <file>` (repeatable) is passed to `readReports` first — when it yields results, do not execute. `--json`/`--out` write `{ checks: CheckResult[] }`.

- [ ] **Step 4: Add the `not-run-check` fixture and golden, then commit**

The fixture has one capability with `SALES-004` enforced, one tagged check whose test body is `test.skip(...)`. Run the tests → PASS. Then `git add -A && git commit -m "feat(cli): run command — not-run/flaky never green, exit 1"`

### Task 8: Integrity reconciliation (spec §8 stage 3)

**Files:**
- Create: `packages/cli/src/registry/integrity.ts`
- Test: `packages/cli/test/unit/integrity.test.ts`, `packages/cli/test/integration/integrity-cli.test.ts`
- Create fixtures: `test/fixtures/orphan-check/**`, `test/fixtures/duplicate-tag/**`, `test/fixtures/tag-case-mismatch/**`, `test/golden/{orphan-check,duplicate-tag,tag-case-mismatch}/**`

**Interfaces:**
- Consumes: `Registry`, `DiscoveredCheck`, `DiscoveryResult`.
- Produces: `reconcile(registry: Registry, discovery: DiscoveryResult): Finding[]`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/integrity.test.ts
import { reconcile } from "../../src/registry/integrity.js";

it("reports both orphan directions, duplicate tags and tag/registry mismatches", () => {
  const codes = (r: Registry, d: DiscoveryResult) => reconcile(r, d).map((f) => f.code).sort();
  expect(codes(reg({ SALES-004: ["sales.a"] }), disc([]))).toEqual(["integrity.rule_without_discovered_check"]);
  expect(codes(reg({ SALES-004: ["sales.a"] }), disc([{ checkId: "sales.x", rules: ["SALES-999"] }]))).toEqual([
    "integrity.check_without_registry_declaration",
    "integrity.unknown_rule_id",
    "integrity.rule_without_discovered_check",
  ]);
  expect(codes(reg({ SALES-004: ["sales.a"] }), disc([{ checkId: "sales.a", rules: ["SALES-004"] }, { checkId: "sales.a", rules: ["SALES-004"] }]))).toEqual([
    "integrity.duplicate_check_tag",
  ]);
  // @rule sales-004 (lower case) must not match SALES-004 (review focus 4)
  expect(codes(reg({ SALES-004: ["sales.a"] }), disc([{ checkId: "sales.a", rules: ["sales-004"] }]))).toContain("integrity.unknown_rule_id");
});

it("reports a @negative-control path that disagrees with the registry (PEND-4)", () => {
  expect(codes(reg({ SALES-004: ["sales.a"], sabotage: ".invariant/sabotages/sales/one.ts" }), disc([{ checkId: "sales.a", rules: ["SALES-004"], negativeControl: ".invariant/sabotages/sales/two.ts" }]))).toContain("integrity.negative_control_mismatch");
});

it("reports a @flow step that does not exist or does not carry the tagged rule", () => {
  const r = reg({ SALES-004: ["sales.a"] }, { flow: "checkout", steps: { s1: ["SALES-002"] } });
  expect(codes(r, disc([{ checkId: "sales.a", rules: ["SALES-004"], flows: [{ flow: "checkout", step: "s9" }] }]))).toContain("integrity.unknown_step");
  expect(codes(r, disc([{ checkId: "sales.a", rules: ["SALES-004"], flows: [{ flow: "checkout", step: "s1" }] }]))).toContain("integrity.rule_not_in_step");
  expect(codes(r, disc([{ checkId: "sales.a", rules: ["SALES-004"], flows: [{ flow: "nope" }] }]))).toContain("integrity.unknown_flow");
});
```

`reg(rules, flow?)` and `disc(checks)` are local helpers in the test file: they build an in-memory `Registry` (a rule with the given declared check ids, an optional flow with the given step→rule map) and a `DiscoveryResult` from partial `DiscoveredCheck`s.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/integrity.test.ts` → FAIL.

- [ ] **Step 3: Implement `reconcile`**

Codes: `integrity.rule_without_discovered_check` (an `enforced`/`draft` rule with no check whose `@check` is discovered), `integrity.check_without_registry_declaration` (a discovered `@check` id with no registry declaration), `integrity.unknown_rule_id` (`@rule` naming a rule that does not exist — including a case mismatch), `integrity.duplicate_check_tag` (the same `@check` id on two tests, or the same `@rule` on two checks of the same rule), `integrity.negative_control_mismatch` (PEND-4: the tag must equal the registry's declared sabotage path), `integrity.unknown_flow`, `integrity.unknown_step`, `integrity.rule_not_in_step` (a `@flow <f>/<s>` tag whose step does not list the tagged rule), plus a pass-through of `DiscoveryResult.errors` as `integrity.discovery_error`. Matching is exact and case-sensitive. Integrity findings are gate errors: the caller maps them to `EXIT.GATE_BROKEN` (the mapping is wrong, so no verdict may be trusted — spec §3 "orphans are integrity findings, not verdicts").

- [ ] **Step 4: Wire into `validate`, add the three fixtures, then commit**

`commands/validate.ts` runs discovery through `createDiscoverySource` and `reconcile` after validation; extend the help text. Add the `orphan-check`, `duplicate-tag` and `tag-case-mismatch` fixtures (each expecting exit `2`). Run `cd packages/cli && npm test` → PASS. Then `git add -A && git commit -m "feat(registry): integrity reconciliation both ways, exit 2"`

### Task 9: Verdict roll-up and the proof decision table

**Files:**
- Create: `packages/cli/src/verdict/types.ts`, `packages/cli/src/verdict/proof.ts`, `packages/cli/src/verdict/compute.ts`
- Test: `packages/cli/test/unit/verdict.test.ts`

**Interfaces:**
- Consumes: `Registry`, `CheckResult`, `DiscoveredCheck`.
- Produces: `type Verdict = "pass" | "fail" | "not-run" | "flaky" | "blocked"`; `type ReasonCode` (string union); `type SabotageOutcome = { status: "not-executed" } | { status: "not-applied" } | { status: "applied"; classification: "assertion" | "harness" | "timeout" }`; `isProof(o: SabotageOutcome): boolean`; `type CheckVerdict = { checkId: string; ruleIds: string[]; flowRefs: FlowRef[]; layer?: CheckLayer; file: string; line: number; runtimeId: string; verdict: Verdict; reason: ReasonCode; message?: string; negativeControl: SabotageOutcome }`; `type RuleVerdict = { ruleId: string; capability: string; criticality: Criticality; status: RuleStatus; verdict: Verdict; reason: ReasonCode; checkIds: string[]; sabotageVerified: boolean }`; `type StepVerdict = { stepId: string; verdict: Verdict; reason: ReasonCode; ruleIds: string[] }`; `type FlowVerdict = { flowId: string; criticality: Criticality; verdict: Verdict; reason: ReasonCode; checkIds: string[]; steps: StepVerdict[] }`; `computeVerdicts(input: { registry: Registry; discovered: DiscoveredCheck[]; results: CheckResult[]; outcomes: Map<string, SabotageOutcome> }): { checks: CheckVerdict[]; rules: RuleVerdict[]; flows: FlowVerdict[] }`; `worst(a: Verdict, b: Verdict): Verdict`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/verdict.test.ts
import { describe, expect, it } from "vitest";
import { isProof } from "../../src/verdict/proof.js";
import { worst } from "../../src/verdict/compute.js";

describe("isProof (spec §7, SELF-004)", () => {
  it("counts only an applied, assertion-classified failure", () => {
    expect(isProof({ status: "applied", classification: "assertion" })).toBe(true);
    expect(isProof({ status: "applied", classification: "harness" })).toBe(false);
    expect(isProof({ status: "applied", classification: "timeout" })).toBe(false);
    expect(isProof({ status: "not-applied" })).toBe(false);
    expect(isProof({ status: "not-executed" })).toBe(false);
  });
});

describe("worst", () => {
  it("orders fail > blocked > flaky > not-run > pass", () => {
    expect(worst("flaky", "not-run")).toBe("flaky");
    expect(worst("blocked", "fail")).toBe("fail");
    expect(worst("pass", "blocked")).toBe("blocked");
    expect(worst("pass", "pass")).toBe("pass");
  });
});

describe("computeVerdicts", () => {
  it("makes a rule not green when any of its checks is not green", () => { /* pass + flaky → flaky, reason check.flaky */ });
  it("makes a flow red and names the step whose governing rule is not green", () => { /* expect flows[0].steps[1].verdict === "fail" and reason "governing_rule_not_green" */ });
  it("makes a flow red when a flow-level check is not green and no rule is", () => { /* reason "flow_check_not_green" */ });
  it("marks sabotageVerified false while outcomes are not-executed", () => { /* every rule has sabotageVerified false (Phase 0/1) */ });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/verdict.test.ts` → FAIL.

- [ ] **Step 3: Implement the three modules**

`proof.ts` is the whole spec §7 decision table: only `applied` + `assertion` is proof. A rule's `sabotageVerified` is `true` only when every one of its checks has a proof outcome. In this delivery no producer exists for anything but `not-executed` (PEND-1), so `sabotageVerified` is always `false` — and that is the fact SELF-004 protects, not a bug.

`compute.ts`: `VERDICT_RANK = { pass: 0, "not-run": 1, flaky: 2, blocked: 3, fail: 4 }`. Rule verdict = `worst` over its checks (`draft`/`deprecated` rules do not participate in the gate but are still reported). Flow verdict = `worst` over (a) every governing rule's verdict, which sets `steps[i].verdict` and `reason: "governing_rule_not_green"` plus `steps[i].reason` detail, and (b) every flow-level check, `reason: "flow_check_not_green"`. `reason` codes for checks: `check.passed`, `check.failed`, `check.not_run`, `check.flaky`, `check.blocked`. A rule with no check at all is `fail` with reason `rule_no_check` (it is also a registry error, so this is the belt-and-braces path).

- [ ] **Step 4: Run the tests, then commit**

Run: `cd packages/cli && npx vitest run test/unit/verdict.test.ts` → PASS. Then `git add -A && git commit -m "feat(verdict): roll-up engine and the sabotage proof decision table"`

### Task 10: Report JSON and the PR comment

**Files:**
- Create: `packages/cli/src/report/shape.ts`, `packages/cli/src/report/write.ts`, `packages/cli/src/report/comment.ts`
- Create: `packages/cli/src/guarantee/class.ts`
- Test: `packages/cli/test/unit/report.test.ts`

**Interfaces:**
- Consumes: `RuleVerdict`, `FlowVerdict`, `CheckVerdict`, `Config`.
- Produces: `type GuaranteeClass = "G1" | "G2" | "G3"`; `type ClassFinding = { code: string; message: string }`; `computeClass(input: { observationAvailable: boolean; protectionFindings: ClassFinding[]; credentialBoundary: boolean }): { class: GuaranteeClass; reasons: string[]; binding: boolean }`; `type DoctorSummary = { ran: boolean; class: GuaranteeClass; reasons: string[]; findings: ClassFinding[]; observation: "available" | "unavailable" }`; `buildReport(input: ReportInput): Report`; `renderComment(report: Report): string`; `type Report` and `type ReportInput` in `shape.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/report.test.ts
import { describe, expect, it } from "vitest";
import { renderComment } from "../../src/report/comment.js";
import { computeClass } from "../../src/guarantee/class.js";

it("escapes Markdown-hostile text in rule statements (review focus 2)", () => {
  const md = renderComment(reportWith({ statement: "A sale | MUST NOT complete\nwhen `stock` < 1 * 2" }));
  expect(md).not.toMatch(/A sale \|/);
  expect(md).toContain("A sale \\| MUST NOT complete when \\`stock\\` < 1 \\* 2");
  expect(md.split("\n").every((l) => !l.includes("\n"))).toBe(true);
});

it("states the guarantee class and the declared-only negative control", () => {
  const md = renderComment(reportWith({}));
  expect(md).toContain("## invariant — G3 (procedural)");
  expect(md).toContain("Seam sabotage is NOT executed in this delivery");
  expect(md).toContain("| Flow | Verdict | Step | Rule | Verdict | Check | Reason |");
});

it("says 'no enforced rules' instead of claiming a vacuous green (review focus 5)", () => {
  expect(renderComment(reportWith({ enforcedRules: 0 }))).toContain("No enforced rules are declared");
});

it("never reaches G1 without an observation or with any protection finding", () => {
  expect(computeClass({ observationAvailable: false, protectionFindings: [], credentialBoundary: false }).class).toBe("G3");
  expect(computeClass({ observationAvailable: false, protectionFindings: [], credentialBoundary: true }).class).toBe("G2");
  expect(computeClass({ observationAvailable: true, protectionFindings: [{ code: "check.not_pinned_to_app", message: "x" }], credentialBoundary: false }).class).toBe("G3");
  expect(computeClass({ observationAvailable: true, protectionFindings: [], credentialBoundary: false }).class).toBe("G1");
});
```

This is the **single** class function in the codebase: Task 19's `runDoctorChecks` calls it with the `severity: "fail"` findings from the §9.3 checks, and Task 13's `verify` calls it with `protectionFindings: []` and `observationAvailable: false` whenever no doctor result is supplied.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/report.test.ts` → FAIL.

- [ ] **Step 3: Implement the report shape and writer**

`shape.ts` fixes the `Report` type — **the wire shape, with snake_case keys throughout** — as `{ schema_version: 1; tool: { name: "invariant"; version: string }; inputs: { mode: "local" | "pr" | "push" | "merge_group"; base: string | null; head: string | null; repo: string | null; run_id: string | null }; guarantee: { class: GuaranteeClass; class_reasons: string[]; binding: boolean; negative_control: "declared-only" | "executed"; doctor: DoctorSummary }; registry: { files: string[]; hashes: Record<string, string> }; immutability: { protected_paths_changed: string[]; flagged: boolean }; integrity: WireFinding[]; checks: WireCheckVerdict[]; rules: WireRuleVerdict[]; flows: WireFlowVerdict[]; exit_code: ExitCode }`. There are no timestamps and no durations. `Write*` are the same shapes as the in-memory types in `verdict/types.ts` with snake_case keys, and `write.ts` performs that one mapping: `ruleId → rule_id`, `checkIds → check_ids`, `flowRefs → flow_refs`, `sabotageVerified → sabotage_verified`, `negativeControl → negative_control`, `exitCode → exit_code`, `Finding.ruleId/flowId/checkId → rule_id/flow_id/check_id`. `hashes` are `sha256:<hex>` of each registry file, in sorted file order; all arrays are sorted by id.

`write.ts` assembles it from `computeVerdicts` output, the config, the discovered checks, integrity findings and the `GuaranteeClass`/`DoctorSummary` the caller supplies.

`guarantee/class.ts` implements spec §9.1: `class` is `G1` only when `observationAvailable` is true **and** `protectionFindings` is empty; `G2` when the class is not G1 and `credentialBoundary` is `"declared"` (PEND-2); `G3` otherwise. `binding = class === "G1" || class === "G2"` (`G3` must never be described as a guarantee). `reasons` is a human-readable line per input that lowered the class.

- [ ] **Step 4: Implement the comment renderer**

`comment.ts` renders, in this exact order: a heading `## invariant — <class> (<mechanism>)`; the class banner with `class_reasons`; the declared-only banner (verbatim: "Seam sabotage is NOT executed in this delivery (Phase 2). No rule is proven able to fail."); the class warning when the class is below G1; then the table `| Flow | Verdict | Step | Rule | Verdict | Check | Reason |`, one row per (flow, step, rule, check), flows and rules sorted by id, and finally a per-rule list for rules in no flow. All cell text is escaped: `|` → `\|`, backticks → `` \` ``, `*` → `\*`, and newlines collapse to a single space. A rule row uses the word `checked` when `sabotageVerified` is false and `proven` only when it is true — never the other way round.

- [ ] **Step 5: Run the tests, then commit**

Run: `cd packages/cli && npx vitest run test/unit/report.test.ts` → PASS. Then `git add -A && git commit -m "feat(report): report JSON, guarantee block, escaped PR comment"`

### Task 11: `invariant verdict` — fail-closed aggregation of upstream jobs

**Files:**
- Create: `packages/cli/src/commands/verdict.ts`
- Test: `packages/cli/test/integration/verdict-cli.test.ts`
- Create fixtures: `test/fixtures/upstream-cancelled/**`, `test/fixtures/report-missing/**`, `test/golden/{upstream-cancelled,report-missing}/**`

**Interfaces:**
- Consumes: `buildReport`, `renderComment`, `computeVerdicts`.
- Produces: `invariant verdict --inputs <dir> [--job-status <job>=<result>]...` reading `<dir>/<job>/<stage-result>.json`; `readStageResults(inputs, jobStatuses): { results: StageResult[]; findings: Finding[] }`; exit codes: `EXIT.GATE_BROKEN` when any upstream job is missing, not `success`, or has no artifact; otherwise `EXIT.GREEN`/`EXIT.PRODUCT_BROKEN` from the roll-up.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/integration/verdict-cli.test.ts
it("is red when an upstream job was cancelled, even with a green checks artifact", async () => {
  const run = await runFixture("upstream-cancelled", {
    args: ["verdict", "--inputs", ".", "--job-status", "invariant-registry=cancelled", "--job-status", "invariant-checks=success", "--job-status", "invariant-negative=success"],
  });
  expect(run.exitCode).toBe(2);
  expect(run.report.guarantee.negative_control).toBe("declared-only");
  expect(run.report.integrity.map((f) => f.code)).toContain("upstream.job_cancelled");
});

it("is red when a report artifact is absent — never infers success from absence", async () => {
  const run = await runFixture("report-missing", { args: ["verdict", "--inputs", ".", "--job-status", "invariant-checks=success"] });
  expect(run.exitCode).toBe(2);
  expect(run.report.integrity.map((f) => f.code)).toContain("upstream.artifact_missing");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npm run build && npx vitest run test/integration/verdict-cli.test.ts` → FAIL.

- [ ] **Step 3: Implement the command**

`StageResult = { stage: "registry" | "checks" | "negative"; job: string; exit_code: ExitCode; findings: Finding[]; checks?: TestCheckResultShape[]; negative?: { declared: number; executed: boolean; findings: Finding[] } }`. The command reads every expected job (`invariant-registry`, `invariant-checks`, `invariant-negative`) from `--inputs`, cross-checks with `--job-status`, and for each problem emits an integrity finding (`upstream.job_missing`, `upstream.job_cancelled` for `cancelled`, `upstream.job_skipped` for `skipped`, `upstream.job_failed` for `failure`, `upstream.artifact_missing`) and forces `EXIT.GATE_BROKEN`. Any `not-run`/`flaky`/`fail` check carried in the artifacts rolls up to `EXIT.PRODUCT_BROKEN` through the normal engine, using the registry and the discovered checks to rebuild check verdicts. `--doctor-result` is validated against `--repo`/`--run-id` (a mismatched envelope is treated as unverifiable: class G3/G2 plus `doctor.result_mismatch`), and its class is compared with `baseline.recorded_class` — a class lower than the baseline yields `EXIT.GATE_BROKEN` with `baseline.regressed` (PEND-6: `invariant-verdict` is where that decision belongs, so a workflow never has to interpret `doctor`'s own exit code). Writes `--out` (default `invariant-report.json`) and `--comment` (default `invariant-comment.md`).

- [ ] **Step 4: Add the two fixtures, then commit**

Each fixture is a directory with the stage-result JSONs (one of them absent or cancelled). Run the tests → PASS. Then `git add -A && git commit -m "feat(cli): verdict command, fail-closed upstream aggregation"`

### Task 12: Immutability (spec §8 stage 4) and event parsing

**Files:**
- Create: `packages/cli/src/ci/event.ts`, `packages/cli/src/immutability/diff.ts`, `packages/cli/src/seams/changed-files.ts`
- Test: `packages/cli/test/unit/immutability.test.ts`, `packages/cli/test/integration/immutability-cli.test.ts`
- Create fixtures: `test/fixtures/rule-changed-in-feature-pr/**`, `test/fixtures/rule-changed-flagged/**`, `test/golden/{rule-changed-in-feature-pr,rule-changed-flagged}/**`
- Modify: `packages/cli/test/helpers/fixture.ts` (add `makeGitRepo`)

**Interfaces:**
- Consumes: `Config`, `Registry`.
- Produces: `readEvent(path: string | undefined): Promise<CiContext>` where `CiContext = { mode: "local" | "pr" | "push" | "merge_group"; base: string | null; head: string | null; repo: string | null; runId: string | null; labels: string[] }`; `interface ChangedFilesProvider { changedFiles(root: string, base: string, head: string): Promise<{ files: string[]; base: string; head: string }> }`; `createChangedFilesProvider(): ChangedFilesProvider`; `immutabilityFinding(input: { changed: string[]; config: Config; context: CiContext; protectedPaths: string[] }): { finding: Finding | null; protectedPathsChanged: string[]; flagged: boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/immutability.test.ts
import { describe, expect, it } from "vitest";
import { readEvent } from "../../src/ci/event.js";
import { immutabilityFinding } from "../../src/immutability/diff.js";
import { DEFAULT_CONFIG } from "../../src/config/model.js";
import { makeTmpRepo } from "../helpers/fixture.js";

const event = (payload: unknown) => makeTmpRepo({ "event.json": JSON.stringify(payload) }).then((root) => `${root}/event.json`);
const pr = (...labels: string[]): CiContext => ({ mode: "pr", base: "b1", head: "h1", repo: null, runId: null, labels });

it("parses a pull_request event offline, including labels and base sha", async () => {
  const ctx = await readEvent(await event({ pull_request: { base: { sha: "b1" }, head: { sha: "h1" }, labels: [{ name: "invariant:rule-change" }] } }));
  expect(ctx).toMatchObject({ mode: "pr", base: "b1", head: "h1", labels: ["invariant:rule-change"] });
});

it("reads a merge_group event from head_sha and degrades to local for anything else", async () => {
  expect((await readEvent(await event({ merge_group: { head_sha: "m1" } }))).mode).toBe("merge_group");
  expect((await readEvent(await event({ push: {} }))).mode).toBe("local");
  expect((await readEvent("/nope")).mode).toBe("local");
});

it("fails when a protected path changed outside the flagged path (spec §12)", () => {
  const { finding } = immutabilityFinding({ changed: ["rules/sales.yaml", "src/app.ts"], config: DEFAULT_CONFIG, context: pr(), protectedPaths: DEFAULT_CONFIG.protectedPaths });
  expect(finding?.code).toBe("immutability.protected_path_changed");
});

it("allows a flagged rule-change PR and records it", () => {
  const out = immutabilityFinding({ changed: ["rules/sales.yaml"], config: DEFAULT_CONFIG, context: pr("invariant:rule-change"), protectedPaths: DEFAULT_CONFIG.protectedPaths });
  expect(out).toEqual({ finding: null, protectedPathsChanged: ["rules/sales.yaml"], flagged: true });
});

it("records but does not fail protected changes on a push (post-merge audit)", () => {
  const out = immutabilityFinding({ changed: [".invariant/sabotages/sales/stock.ts"], config: DEFAULT_CONFIG, context: { ...pr(), mode: "push" }, protectedPaths: DEFAULT_CONFIG.protectedPaths });
  expect(out).toEqual({ finding: null, protectedPathsChanged: [".invariant/sabotages/sales/stock.ts"], flagged: false });
});

it("treats .invariant/, the workflow and CODEOWNERS as protected", () => {
  for (const f of [".invariant/sabotages/sales/stock.ts", ".github/workflows/invariant.yml", ".github/CODEOWNERS"])
    expect(immutabilityFinding({ changed: [f], config: DEFAULT_CONFIG, context: pr(), protectedPaths: DEFAULT_CONFIG.protectedPaths }).finding?.code).toBe("immutability.protected_path_changed");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/immutability.test.ts` → FAIL.

- [ ] **Step 3: Implement the three modules**

`ci/event.ts` reads `GITHUB_EVENT_PATH` (or `--event`) JSON. `pull_request` → `mode: "pr"`, `base = pull_request.base.sha`, `head = pull_request.head.sha`, `labels = pull_request.labels[].name`; `merge_group` → `mode: "merge_group"`, `head = merge_group.head_sha`; anything else or unreadable → `mode: "local"` with nulls (never throw). `immutability/diff.ts` compares the changed files against `protectedPaths` by prefix (`rules/`, `.invariant/`) and by exact path (the workflow, CODEOWNERS). Outside a PR (`mode: "push" | "merge_group" | "local"`) protected changes are recorded but do not fail. Inside a PR, a protected change fails unless the context's labels include `config.ruleChange.label`. `seams/changed-files.ts` is the seam (SELF-003), with a `git`-backed implementation: `execFile("git", ["diff", "--name-only", "--no-renames", `${base}...${head}`], { cwd: root })`, an empty diff plus a `git fetch --depth=1 origin <base>` retry when `base` is unknown, and a `Finding`-worthy error when git is unavailable.

- [ ] **Step 4: Wire `--base`/`--event` into `validate`, add the two fixtures, then commit**

`commands/validate.ts` calls the loader, `reconcile` and immutability, prints the immutability finding with the others, and returns `EXIT.PRODUCT_BROKEN` when the only findings are immutability findings (spec §12 says exit `1` for a rule changed in a feature PR) while returning `EXIT.GATE_BROKEN` whenever a validation, config or integrity finding is present (that code wins). Task 13 records these findings under both `immutability` and `integrity` in the report while keeping `exit_code: 1`.

The two fixtures cannot be driven by `runFixture` alone, because the diff needs real commits: add `makeGitRepo(files: Record<string, string>): Promise<{ root: string; baseSha: string }>` to `test/helpers/fixture.ts` (`git init -q`, `git -c user.email=… -c user.name=… add -A`, `commit -m base`, return the sha), then in `test/integration/immutability-cli.test.ts` create the repo, commit a protected-path change on top, and run `spawnCli(["validate", "--base", baseSha, "--event", <fixture event path>])`: expect `1` for `rule-changed-in-feature-pr` (an event without the label) and `0` for `rule-changed-flagged` (the same change with `labels: [{name: "invariant:rule-change"}]`). Pin the stdout with `expectGolden`.

- [ ] **Step 5: Run the tests, then commit**

Run: `cd packages/cli && npm test` → PASS. Then `git add -A && git commit -m "feat(immutability): protected-path diff, rule-change flag, exit 1"`

### Task 13: `invariant verify` — the eight stages in one process

**Files:**
- Create: `packages/cli/src/commands/verify.ts`, `packages/cli/src/context.ts`
- Test: `packages/cli/test/integration/verify-cli.test.ts`
- Create fixtures: `test/fixtures/flaky-check/**`, `test/fixtures/healthy-registry/**`, `test/golden/{flaky-check,healthy-registry}/**`

**Interfaces:**
- Consumes: everything above.
- Produces: `buildVerifyContext(input: VerifyInput): Promise<VerifyContext>` where `VerifyInput = { root: string; adapterId?: string; base?: string; head?: string; event?: string; reports?: string[] }` and `VerifyContext = { root: string; config: Config; registry: Registry; discovery: DiscoveryResult; changedFiles: ChangedFilesProvider; runner: CheckRunner; forgeProbe: ForgeProbe }`. Every collaborator is created **only** through its module in `src/seams/` — that is what makes the SELF rules sabotage-able (spec §7) and why a check must build its context through `buildVerifyContext` instead of assembling collaborators by hand. `runVerify(input: VerifyInput & { doctorResult?: string; repo?: string; runId?: string; out?: string; comment?: string }): Promise<{ report: Report; comment: string; code: ExitCode }>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/integration/verify-cli.test.ts
it("exits 0 and writes report + comment for a healthy registry", async () => {
  const run = await runFixture("healthy-registry", { args: ["verify"] });
  expect(run.exitCode).toBe(0);
  await expectGolden("healthy-registry", normalizeReport(run.report!), "report.json");
  await expectGolden("healthy-registry", run.comment!, "comment.md");
});

it("exits 1 when a check is flaky per the read report", async () => {
  const run = await runFixture("flaky-check", { args: ["verify", "--reports", "reports/vitest.json"] });
  expect(run.exitCode).toBe(1);
  expect(run.report?.rules[0]?.verdict).toBe("flaky");
});

it("never claims G1 without a doctor result and records declared-only negative control", async () => {
  const run = await runFixture("healthy-registry", { args: ["verify"] });
  expect(run.report?.guarantee.class).toBe("G3");
  expect(run.report?.guarantee.negative_control).toBe("declared-only");
  expect(run.report?.rules.every((r) => r.sabotage_verified === false)).toBe(true);
});
```

`normalizeReport` and `expectGolden` come from `test/helpers/goldens.ts` (Task 3).

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npm run build && npx vitest run test/integration/verify-cli.test.ts` → FAIL.

- [ ] **Step 3: Implement `context.ts` and the command**

`context.ts` is the composition root: builds `Config`, loads the registry, calls `createDiscoverySource(config).discover(root)`, `createChangedFilesProvider()`, `createCheckRunner(findAdapter(config.adapter))`, and `createForgeProbe(config)`.

`commands/verify.ts` runs the eight stages in order, translating to exit codes: stage 1 `registry.*`/`config.*` findings and stage 2 discovery errors and stage 3 integrity findings → `EXIT.GATE_BROKEN` with **no** rule verdicts emitted; stage 4 immutability → `EXIT.PRODUCT_BROKEN`; stages 5–7 → `EXIT.PRODUCT_BROKEN` when any enforced rule or any flow is not green; stage 8 writes the report and the comment and returns the code. Two details are load-bearing and must be visible in the code:

- **Sabotage outcomes.** `computeVerdicts` is called with `outcomes` = a map of every declared check id to `{ status: "not-executed" }` (PEND-1: nothing produces other outcomes in this delivery). That is what makes `negative_control: "declared-only"` and `sabotageVerified: false` true by construction rather than by omission.
- **The class.** When `--doctor-result <file>` is supplied, its envelope is accepted only if its `repo`/`run_id` match `--repo`/`--run-id`, and the class comes from its findings passed through `computeClass`; otherwise the class is `computeClass({ observationAvailable: false, protectionFindings: [], credentialBoundary: config.credentialBoundary === "declared" })`. A missing or mismatched doctor result must never raise the class (spec §9.1), and a class lower than `baseline.recorded_class` yields `EXIT.GATE_BROKEN` with `baseline.regressed` (the same rule as `verdict`, so the gate cannot get weaker without going red).

`--reports` is passed to `readReports` before any execution (prefer reading). Print a one-line summary to stdout: `<n> rules green, <n> not green, class <class>, negative control <declared-only|executed>`.

- [ ] **Step 4: Add the two fixtures, then commit**

`healthy-registry` is a real Vitest project fixture (`package.json` + a tagged test) so the happy path exercises the real adapter; `runFixture` symlinks the plugin's `node_modules` into the copy (Task 15), so nothing is downloaded. `flaky-check` reads a committed `reports/vitest.json` containing `retryCount: 2` for its only check. Run `cd packages/cli && npm test` → PASS. Then `git add -A && git commit -m "feat(cli): verify pipeline, stages 1-8, report + comment"`

### Task 14: `invariant negative` — stage 6 in declaration form

**Files:**
- Create: `packages/cli/src/negative/declared.ts`, `packages/cli/src/commands/negative.ts`, `packages/cli/src/seams/sabotage-source.ts`
- Test: `packages/cli/test/unit/negative-declared.test.ts`, `packages/cli/test/integration/negative-cli.test.ts`
- Create fixtures: `test/fixtures/sabotage-missing-alias/**`, `test/golden/sabotage-missing-alias/**`

**Interfaces:**
- Consumes: `Registry`, `fsutil`, `loadRegistry`, and the `capability` builder from `test/helpers/registry.ts`.
- Produces: `checkDeclared(registry: Registry, root: string): Finding[]`; `createSabotageSource(root: string): SabotageSource` where `SabotageSource = { read(repoRelativePath: string): Promise<{ text: string; seamAlias: string | null } | null> }`; `invariant negative` returning `EXIT.GATE_BROKEN` for an incomplete declaration and `EXIT.GREEN` otherwise while printing the not-executed notice.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/negative-declared.test.ts
it("accepts a sabotage that exists and declares exactly one @seam-alias", async () => {
  const root = await makeTmpRepo({
    "rules/sales.yaml": capability("SALES-004"),
    ".invariant/sabotages/sales/stock.ts": "// @seam-alias packages/app/src/seams/stock-policy.ts\nexport const available = () => ({ available: () => Infinity });\n",
    "packages/app/src/seams/stock-policy.ts": "export const available = () => ({ available: () => 1 });\n",
  });
  expect(checkDeclared((await loadRegistry(root)).registry, root)).toEqual([]);
});

it("rejects a missing sabotage file, a missing @seam-alias, and an alias pointing at the sabotage itself", async () => {
  expect((await findingsFor({})).map((f) => f.code)).toContain("negative.sabotage_missing");
  expect((await findingsFor({ alias: null })).map((f) => f.code)).toContain("negative.seam_alias_missing");
  expect((await findingsFor({ alias: ".invariant/sabotages/sales/stock.ts" })).map((f) => f.code)).toContain("negative.seam_alias_target_invalid");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/negative-declared.test.ts` → FAIL.

- [ ] **Step 3: Implement the declaration checks and the command**

`checkDeclared` walks every `enforced` rule's checks: the sabotage file must exist (code `negative.sabotage_missing`), must contain exactly one `@seam-alias <path>` (code `negative.seam_alias_missing` / `negative.seam_alias_duplicate`), and that path must resolve inside the repo, must exist, and must not be the sabotage file itself (`negative.seam_alias_target_invalid`). `seams/sabotage-source.ts` reads sabotage files (the seam Phase 2 will sabotage to prove the *declaration* check can fail). `commands/negative.ts` prints, verbatim and on stdout as the first line: `negative control: declared-only — seam sabotage is NOT executed in this delivery (Phase 2)`, then `declared: <n> checks`, then any findings.

- [ ] **Step 4: Add the fixture, run everything, commit**

Run: `cd packages/cli && npm test` → PASS. Then `git add -A && git commit -m "feat(negative): declared-only stage 6 checks and honest notice"`

### Task 15: Fixture helpers for real Vitest projects, goldens and the stub adapter

**Files:**
- Create: `packages/cli/test/helpers/fixture.ts` (`makeVitestRepo`, extending Task 2's `makeTmpRepo`), `packages/cli/test/helpers/stub-adapter.ts`
- Modify: `packages/cli/test/helpers/run-cli.ts` (add the offline `node_modules` symlinking)
- Test: `packages/cli/test/unit/helpers.test.ts`

**Interfaces:**
- Consumes: nothing project-specific.
- Produces: `makeVitestRepo(files: Record<string, string>, opts?: { into?: string }): Promise<string>`; `runFixture` now makes a fixture project that contains a `package.json` runnable offline; `stubAdapter(spec: { discovered: DiscoveredCheck[]; results: CheckResult[] }): Adapter`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/helpers.test.ts
it("runs a real project's vitest through a symlinked node_modules, offline", async () => {
  const root = await makeVitestRepo({
    "package.json": JSON.stringify({ name: "fx", type: "module", private: true }),
    "src/a.test.ts": `import { expect, test } from "vitest";\ntest("ok", () => { expect(1).toBe(1); });\n`,
  });
  const { exitCode } = await spawnCli(["run", "--root", root], { cwd: root });
  expect(exitCode).toBe(0);
});

it("is idempotent when the same package is symlinked twice", async () => {
  const files = { "package.json": "{}" };
  const root = await makeVitestRepo(files);
  expect(await makeVitestRepo(files, { into: root })).toBe(root);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/helpers.test.ts` → FAIL.

- [ ] **Step 3: Implement the helpers**

`makeVitestRepo` writes the files and creates `<root>/node_modules/{vitest,typescript,yaml,ajv,.bin}` as symlinks into `packages/cli/node_modules`, skipping any that already exist (idempotent). The symlink makes `node <root>/node_modules/vitest/vitest.mjs` — what `runChecks` spawns — resolvable inside the fixture; Node resolves the realpath, so Vitest's own dependencies resolve inside the plugin's `node_modules`. Fail with an actionable message (`run npm install in packages/cli`) when the plugin's `node_modules` is absent. Add the same symlinking to `runFixture` **after** it copies the fixture, so a corpus fixture that contains a `package.json` runs the real Vitest without committing `node_modules` to git. `stubAdapter` implements the `Adapter` interface in memory (discovery + results by `runtimeId`), and every test that needs a deterministic adapter uses it instead of the real one.

- [ ] **Step 4: Migrate the earlier integration tests, then commit**

Replace the ad-hoc repo construction in `test/integration/run-cli.test.ts` and `test/integration/verify-cli.test.ts` with these helpers where they overlap; delete the duplicates. Run `cd packages/cli && npm test` → PASS. Then `git add -A && git commit -m "test(helpers): offline vitest fixtures, golden and stub-adapter helpers"`

### Task 16: The shipped CI workflow

**Files:**
- Create: `packages/cli/src/assets/workflow.yml` (template), `packages/cli/src/workflow/render.ts`
- Create: `.github/workflows/invariant.yml` (the rendered dogfood instance)
- Test: `packages/cli/test/unit/workflow-render.test.ts`, `packages/cli/test/unit/workflow-drift.test.ts`

**Interfaces:**
- Consumes: `Config`.
- Produces: `renderWorkflow(template: string, params: { cliSetup: string; invariantCmd: string; invariantVersion: string; protectedPaths: string[] }): string`; the shipped template's four jobs and its single required check.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/workflow-render.test.ts
import { parse } from "yaml";
it("renders a valid workflow whose required check is exactly invariant-verdict", async () => {
  const text = renderWorkflow(await readFile("src/assets/workflow.yml", "utf8"), DEFAULTS);
  const yml = parse(text);
  expect(Object.keys(yml.jobs)).toEqual(["invariant-registry", "invariant-checks", "invariant-negative", "invariant-verdict"]);
  expect(yml.jobs["invariant-verdict"].uses).toBeUndefined();       // plain job ⇒ context is exactly `invariant-verdict`
  expect(yml.jobs["invariant-verdict"].if).toBe("always()");
  expect(yml.jobs["invariant-verdict"].needs).toEqual(["invariant-registry", "invariant-checks", "invariant-negative"]);
  expect(Object.keys(yml.on).sort()).toEqual(["merge_group", "pull_request", "workflow_call"]);
  for (const job of Object.values(yml.jobs)) expect(job.permissions.contents).toBe("read");
});
```

```ts
// packages/cli/test/unit/workflow-drift.test.ts
it("the committed workflow is exactly the template rendered with the dogfood parameters", async () => {
  const committed = await readFile("../../.github/workflows/invariant.yml", "utf8");
  expect(committed).toBe(renderWorkflow(await readFile("src/assets/workflow.yml", "utf8"), DOGFOOD_PARAMS));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/workflow-render.test.ts test/unit/workflow-drift.test.ts` → FAIL.

- **Step 3: Write the template**

`on: { pull_request: {}, merge_group: {}, workflow_call: {} }`. Each of the three work jobs: `permissions: { contents: read }`, `actions/checkout@v4` with `fetch-depth: 0` (the registry job needs history for the immutability diff), `actions/setup-node@v4` with `node-version: 20`, then a "Prepare invariant CLI" step running `__CLI_SETUP__` (default `npm install --no-save --no-fund invariant@__INVARIANT_VERSION__`), then the job's command with `__INVARIANT_CMD__` (default `npx --no-install invariant`):
- `invariant-registry`: `--base ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || '' }}` `validate --json --out registry-result.json`; `actions/upload-artifact@v4` with `if: always()`.
- `invariant-checks`: `run --json --out checks-result.json` plus a `--reports` glob input (`inputs.reports` with default `''`); upload with `if: always()`.
- `invariant-negative`: `negative --json --out negative-result.json`; upload with `if: always()`.

`invariant-verdict` is a plain job: `needs` all three, `if: always()`, `permissions: { contents: read, pull-requests: write }`, `actions/checkout@v4` (the registry loader runs again here), the CLI preparation step, then `actions/download-artifact@v4` for all three (`if: always()`). Then, in order: `__INVARIANT_CMD__ doctor --json --out invariant-doctor.json --repo ${{ github.repository }} --run-id ${{ github.run_id }}` with `continue-on-error: true` (a doctor that cannot reach the forge must still produce the class it can prove, and the decision about the class belongs to the next step — never to a workflow-level ignore), then `__INVARIANT_CMD__ verdict --inputs ./invariant-inputs --job-status invariant-registry=${{ needs.invariant-registry.result }} --job-status invariant-checks=${{ needs.invariant-checks.result }} --job-status invariant-negative=${{ needs.invariant-negative.result }} --doctor-result invariant-doctor.json --repo ${{ github.repository }} --run-id ${{ github.run_id }} --base ${{ github.event.pull_request.base.sha || '' }} --head ${{ github.sha }}`, then uploads `invariant-report.json` and `invariant-doctor.json` with `if: always()`, and finally posts the comment on pull requests only via `gh pr comment ${{ github.event.pull_request.number }} --body-file invariant-comment.md` with `GH_TOKEN: ${{ github.token }}` and `if: always()`. Add a `# NOTE:` comment beside the doctor step: the forge probe needs the optional secret `INVARIANT_DOCTOR_TOKEN` (a fine-grained PAT with **Administration: read**; `GITHUB_TOKEN` cannot read rulesets or branch protection), and its absence lowers the class honestly instead of failing the workflow; also note that the doctor step must be able to run without the secret.

Add a header comment to the template naming PEND-5: if the project embeds this file through `workflow_call`, GitHub reports the check as `<caller job> / <called job>`; in that case record the exact context in `.invariant/protection-baseline.json` (`expected.required_context`) so `doctor` verifies the right name.

- [ ] **Step 4: Render the dogfood instance and commit**

`DOGFOOD_PARAMS` = `{ cliSetup: "npm ci --ignore-scripts && npm run build", invariantCmd: "node packages/cli/dist/cli.js", invariantVersion: <version>, protectedPaths: DEFAULT_CONFIG.protectedPaths }`. Write the rendered file to `.github/workflows/invariant.yml`. Run `cd packages/cli && npm test` → PASS. Then `git add -A && git commit -m "feat(ci): shipped invariant workflow, single required check invariant-verdict"`

### Task 17: CODEOWNERS parser, validator and coverage

**Files:**
- Create: `packages/cli/src/doctor/codeowners.ts`
- Test: `packages/cli/test/unit/codeowners.test.ts`

**Interfaces:**
- Consumes: `fsutil`.
- Produces: `parseCodeowners(text: string): { rules: CodeownersRule[]; errors: CodeownersError[] }` where `CodeownersRule = { pattern: string; owners: string[]; line: number; negated: boolean; section: string | null }` and `CodeownersError = { line: number; message: string; kind: "ownerless" | "negation" | "invalid_pattern" | "unknown_owner_kind" }`; `coversPaths(rules: CodeownersRule[], paths: string[]): { path: string; owner: string | null }[]` with **last matching pattern wins**.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/codeowners.test.ts
import { parseCodeowners, coversPaths } from "../../src/doctor/codeowners.js";

it("reports the syntax errors GitHub silently skips (spec §9.2 caveat)", () => {
  const { errors } = parseCodeowners([
    "/rules/ @alice",
    "!/rules/secret/ @alice",           // negation is not supported
    "/.invariant/",                      // ownerless
    "/bad/ @alice @",                    // malformed handle
  ].join("\n"));
  expect(errors.map((e) => e.kind).sort()).toEqual(["invalid_pattern", "negation", "ownerless"]);
});

it("resolves coverage with last-match-wins and requires an owner for each protected path", () => {
  const { rules } = parseCodeowners(["/rules/ @alice", "/rules/ @bob", "/.invariant/ @alice"].join("\n"));
  expect(coversPaths(rules, ["rules/self.yaml"])).toEqual([{ path: "rules/self.yaml", owner: "@bob" }]);
  expect(coversPaths(rules, ["/etc/passwd"])).toEqual([{ path: "/etc/passwd", owner: null }]);
});

it("flags the file itself having no owner", () => {
  const { rules } = parseCodeowners("/rules/ @alice\n/.github/CODEOWNERS @alice\n");
  expect(coversPaths(rules, [".github/CODEOWNERS"])).toEqual([{ path: ".github/CODEOWNERS", owner: "@alice" }]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/codeowners.test.ts` → FAIL.

- [ ] **Step 3: Implement the parser**

Handle: comments (`#`), blank lines, `[Section]` headers, patterns with a leading `/` (root-relative) or `*`/`**`, owners that must be `@user`, `@org/team` or an email; `!` negation → `negation` error (GitHub does not support it in CODEOWNERS); a pattern with no owners → `ownerless`; an owner token that is not one of the three forms → `invalid_pattern`; a token like `\#` → `invalid_pattern` (backslash escaping is not supported). Report exactly one error per bad line, never throw, and keep a valid line usable. Also expose `sizeOk(bytes)` for the 3 MB limit (over the limit GitHub does not load the file at all).

- [ ] **Step 4: Run the tests, then commit**

Run: `cd packages/cli && npx vitest run test/unit/codeowners.test.ts` → PASS. Then `git add -A && git commit -m "feat(doctor): CODEOWNERS parser, syntax findings, last-match coverage"`

### Task 18: Forge probe — interface and GitHub REST implementation

**Files:**
- Create: `packages/cli/src/doctor/probe.ts`, `packages/cli/src/doctor/github.ts`, `packages/cli/src/seams/forge-probe.ts`
- Test: `packages/cli/test/unit/github-probe.test.ts`
- Create fixtures: `test/fixtures/probe/*.json` (canned API responses)

**Interfaces:**
- Consumes: `Config`.
- Produces: `type DoctorObservation = { available: true; repo: { owner: string; name: string; defaultBranch: string; visibility: "public" | "private" }; protection: { mechanism: "ruleset" | "branch-protection" | "none"; requiredContexts: { context: string; appId: number | null }[]; codeOwnerReview: boolean; bypassActors: { type: string; id: number | null; mode: string }[]; mergeQueue: "enabled" | "unknown" } } | { available: false; reason: string }`; `interface ForgeProbe { observe(root: string): Promise<DoctorObservation> }`; `createForgeProbe(config: Config): ForgeProbe`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/github-probe.test.ts
import { observeFromApi } from "../../src/doctor/github.js";

it("reads a ruleset as the protection mechanism, with app pinning and bypass actors", async () => {
  const obs = await observeFromApi(fakeFetch({
    "/repos/o/r": { default_branch: "main", visibility: "public", owner: { login: "o" }, name: "r" },
    "/repos/o/r/rulesets": [{ id: 1, target: "branch", enforcement: "active" }],
    "/repos/o/r/rulesets/1": {
      target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
      rules: [
        { type: "required_status_checks", parameters: { required_status_checks: [{ context: "invariant-verdict", integration_id: 15368 }] } },
        { type: "pull_request", parameters: { require_code_owner_review: true } },
      ],
      bypass_actors: [{ actor_id: null, actor_type: "DeployKey", bypass_mode: "always" }],
    },
  }), { owner: "o", name: "r", token: "t" });
  expect(obs).toMatchObject({
    available: true,
    protection: { mechanism: "ruleset", requiredContexts: [{ context: "invariant-verdict", appId: 15368 }], codeOwnerReview: true },
  });
  expect(obs.available && obs.protection.bypassActors).toEqual([{ type: "DeployKey", id: null, mode: "always" }]);
});

it("prefers classic branch protection when it carries the check, and reads app_id", async () => {
  // GET /repos/o/r/branches/main/protection → required_status_checks.checks[0].app_id, required_pull_request_reviews.require_code_owner_reviews
});

it("ignores a ruleset that does not target the default branch or is not enforced", async () => {
  // ref_name.include: ["release/*"], enforcement: "evaluate" → available: true, mechanism: "none"
});

it("reports available: false with a reason when the token is missing or the API returns 403", async () => {
  expect(await observeFromApi(fakeFetch({}), { owner: "o", name: "r", token: null })).toEqual({ available: false, reason: expect.stringContaining("no token") });
  expect(await observeFromApi(fakeFetch({ "/repos/o/r": 403 }), { owner: "o", name: "r", token: "t" })).toMatchObject({ available: false });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/github-probe.test.ts` → FAIL.

- [ ] **Step 3: Implement the probe**

`observeFromApi(fetchImpl, { owner, name, token })` uses `fetch` (Node ≥20 built-in) against `GET /repos/{owner}/{name}`, `GET /repos/{owner}/{name}/rulesets`, `GET /repos/{owner}/{name}/rulesets/{id}`, `GET /repos/{owner}/{name}/branches/{branch}/protection`, and `GET /repos/{owner}/{name}/codeowners/errors` (the last one is optional corroboration; the offline parser in Task 17 is authoritative). Ruleset selection: `target === "branch"`, `enforcement === "active"`, and `conditions.ref_name.include` containing `~DEFAULT_BRANCH`. Classic protection is used when it exists and carries a required context (spec §9.3 accepts either mechanism). Map ruleset `rules[].parameters.required_status_checks[]` → `{ context, appId: integration_id ?? null }`; classic `required_status_checks.checks[]` → `{ context, appId: app_id }`; `require_code_owner_review` (rulesets) and `require_code_owner_reviews` (classic) → `codeOwnerReview`; `bypass_actors` → `bypassActors`; a ruleset with a `merge_queue` rule → `mergeQueue: "enabled"`, else `"unknown"` (PEND-7). No token → `{ available: false, reason: "no token for <tokenEnv>" }`. Any non-2xx → `available: false` with the status and endpoint in the reason. Never throw.

`seams/forge-probe.ts` exports `createForgeProbe(config)` which reads the token from `config.doctor.tokenEnv` and delegates to `github.ts`. This is the seam SELF-005 sabotages.

- [ ] **Step 4: Run the tests, then commit**

Run: `cd packages/cli && npx vitest run test/unit/github-probe.test.ts` → PASS. Then `git add -A && git commit -m "feat(doctor): ForgeProbe interface and GitHub REST observation"`

### Task 19: Doctor checks, class computation and the baseline

**Files:**
- Create: `packages/cli/src/doctor/checks.ts`, `packages/cli/src/doctor/baseline.ts`, `packages/cli/src/guarantee/reasons.ts`
- Test: `packages/cli/test/unit/doctor-checks.test.ts`
- Create fixtures: `test/fixtures/doctor/*.json` (observations), goldens `test/golden/doctor-*/**`

**Interfaces:**
- Consumes: `DoctorObservation`, `Config`, `parseCodeowners`.
- Produces: `type DoctorFinding = { code: string; severity: "fail" | "info"; message: string }`; `runDoctorChecks(input: { observation: DoctorObservation; config: Config; baseline: Baseline; root: string; workflowText: string; workflowFiles: string[] }): { findings: DoctorFinding[]; class: GuaranteeClass; reasons: string[] }`; `type Baseline = { schema_version: 1; recorded_class: GuaranteeClass; expected: { required_context: string; required_context_app_id: number; protected_paths: string[]; bypass_actors: { type: string; id: number | null; mode: string }[] } }`; `readBaseline(root)`, `writeBaseline(root, baseline)`, `renderBaseline(baseline)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/doctor-checks.test.ts
const base = (over: Partial<Baseline["expected"]> = {}, cls: GuaranteeClass = "G1"): Baseline => ({ schema_version: 1, recorded_class: cls, expected: { required_context: "invariant-verdict", required_context_app_id: 15368, protected_paths: DEFAULT_CONFIG.protectedPaths, bypass_actors: [], ...over } });

describe("runDoctorChecks (spec §9.3)", () => {
  it("is G1 when the pinned check, code-owner review, empty bypass and coverage all hold", () => {
    expect(runDoctorChecks({ observation: fullObservation(), config: DEFAULT_CONFIG, baseline: base(), root, workflowText: WF, workflowFiles: ["invariant.yml"] })).toMatchObject({ class: "G1" });
  });
  it("is not G1 when the checks are not required", () => { /* requiredContexts: [] → reason protection.no_required_check */ });
  it("is not G1 when the required check is not pinned to the expected app (spec §9.2)", () => { /* appId: null → check.not_pinned_to_app */ });
  it("is not G1 when a protected path is not covered by code-owner review", () => { /* CODEOWNERS without /rules/ → codeowners.path_uncovered */ });
  it("fails on a CODEOWNERS syntax error even when the class was G3", () => { /* severity "fail" */ });
  it("fails when a bypass actor appeared or grew since the baseline (spec §12)", () => { /* bypass.grew */ });
  it("fails when merge queue is enabled but the workflow has no merge_group trigger", () => { /* merge_queue.workflow_missing_trigger */ });
  it("fails when another workflow defines a job named invariant-verdict (ambiguous context)", () => { /* check.name_ambiguous */ });
  it("fails when the observed class regressed below the recorded baseline class", () => { /* baseline.regressed */ });
  it("is G3 — never G1 — for a repository with no protection at all", () => { /* protection.none → class G3, no claim of G1 */ });
  it("is G2 when a credential boundary is declared and only protection is missing (PEND-2)", () => { /* config credentialBoundary: "declared" */ });
  it("records merge_queue: unknown without downgrading (PEND-7)", () => { /* mergeQueue: "unknown" → no merge_queue finding */ });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/doctor-checks.test.ts` → FAIL.

- [ ] **Step 3: Implement the checks and the baseline**

Implement spec §9.3 items 1–7 verbatim plus the ambiguity check from GitHub's own guidance that job names must be unique across workflows. Item 7 is the fallback: when the class cannot be G1, the finding list carries the mechanism actually in force and `reasons` explains it. `baseline.ts` reads `.invariant/protection-baseline.json` (absent → a synthetic baseline with `recorded_class: "G3"` and the default expectations, so a fresh repo is never blocked). `runDoctorChecks` compares the required context with `baseline.expected.required_context` (PEND-5) and the observed bypass list with `baseline.expected.bypass_actors` (a superset → `bypass.grew`; a non-empty list at all prevents G1). The class comes from the **single** function in Task 10 — `computeClass({ observationAvailable: observation.available, protectionFindings: findings.filter((f) => f.severity === "fail").map(({ code, message }) => ({ code, message })), credentialBoundary: config.credentialBoundary === "declared" })` — and `baseline.regressed` is appended when that class ranks below `baseline.recorded_class`.

- [ ] **Step 4: Run the tests, then commit**

Run: `cd packages/cli && npx vitest run test/unit/doctor-checks.test.ts` → PASS. Then `git add -A && git commit -m "feat(doctor): §9.3 checks, class computation, protection baseline"`

### Task 20: `invariant doctor` command

**Files:**
- Create: `packages/cli/src/commands/doctor.ts`, `packages/cli/src/assets/baseline.json`
- Test: `packages/cli/test/integration/doctor-cli.test.ts`, `packages/cli/test/self/self-005.test.ts`

**Interfaces:**
- Consumes: `createForgeProbe`, `runDoctorChecks`, `readBaseline`, `writeBaseline`.
- Produces: `invariant doctor` writing a `DoctorResult = { schema_version: 1; repo: string | null; run_id: string | null; class: GuaranteeClass; reasons: string[]; findings: DoctorFinding[]; observation: DoctorObservation }` to `--out` (default `invariant-doctor.json`); exit `0` when the observed class is at or above `baseline.recorded_class`, `1` when it is below (PEND-6 regression gate); `--strict` replaces that rule with "exit `1` whenever the class is below G1"; `--record` writes the baseline with the observed class and the observed required context/app/protected paths/bypass list. The command's exit code is for humans and for `--strict` users: in CI the regression decision is made by `verdict` (Task 11), so the workflow never has to interpret this exit code.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/integration/doctor-cli.test.ts
it("prints the class actually in force when no token is available, and never claims G1", async () => {
  const run = await runFixture("no-protection", { args: ["doctor", "--json"] });
  expect(run.exitCode).toBe(0);                       // baseline is G3 by default (PEND-6)
  expect(run.doctor.class).toBe("G3");
  expect(run.doctor.observation.available).toBe(false);
  expect(run.stdout).toContain("G3 (procedural)");
});

it("exits 1 under --strict for a repository with no protection", async () => {
  expect((await runFixture("no-protection", { args: ["doctor", "--strict"] })).exitCode).toBe(1);
});

it("--record writes the observed class and attributes into the baseline", async () => {
  const run = await runFixture("no-protection", { args: ["doctor", "--record"] });
  expect(run.baseline.recorded_class).toBe("G3");
  expect(run.baseline.expected.required_context).toBe("invariant-verdict");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npm run build && npx vitest run test/integration/doctor-cli.test.ts` → FAIL.

- [ ] **Step 3: Implement the command**

Compose: `loadConfig` → `createForgeProbe(config).observe(root)` → read the committed workflow at `.github/workflows/invariant.yml` → `runDoctorChecks`. Print a human block (`observation: available|unavailable (<reason>)`, `protection: <mechanism>`, `class: <class> (<mechanism>)`, one line per finding, and a final line naming what the class means for the merge). `--json`/`--out` write the `DoctorResult`; the `repo`/`run-id` fields come from `--repo`/`--run-id` or `GITHUB_REPOSITORY`/`GITHUB_RUN_ID` so `verify`/`verdict` can validate the envelope. `verify` and `verdict` convert a `DoctorResult` into the report's `DoctorSummary` (`ran: true`, and `observation: "available" | "unavailable"` from the observation). The command must run fully offline when the probe is unavailable: the CODEOWNERS parse and the workflow-trigger checks are offline and still report their findings.

- [ ] **Step 4: Run the tests, then commit**

Run: `cd packages/cli && npm test` → PASS. Then `git add -A && git commit -m "feat(doctor): CLI command, class reporting, baseline recording"`

### Task 21: `invariant init` and the walking skeleton

**Files:**
- Create: `packages/cli/src/assets/config.yaml`, `packages/cli/src/assets/ruleset.json`, `packages/cli/src/assets/codeowners-block.txt`, `packages/cli/src/assets/walking-skeleton/**`
- Create: `packages/cli/src/commands/init.ts`, `packages/cli/src/init/plan.ts`
- Test: `packages/cli/test/unit/init-plan.test.ts`, `packages/cli/test/integration/init-cli.test.ts`

**Interfaces:**
- Consumes: `renderWorkflow`, `loadConfig`, `Baseline`.
- Produces: `planInit(input: { root: string; owner: string; adapter: string; cliSetup: string; invariantCmd: string; invariantVersion: string; baseline: Baseline }): Promise<{ writes: { path: string; content: string; mode: "create" | "append-block" | "skip" }[]; findings: Finding[] }>` — **pure**: it reads the current tree and computes the writes, performing no writes and no network I/O. `invariant init` computes the `Baseline` (by running the doctor observation) and then performs the writes.

Walking skeleton contents (one capability, one critical flow, one rule with a seam and a sabotage):

- `rules/example.yaml` — capability `example`, rule `EXAMPLE-001`, `status: enforced`, `owners: [<owner>]`, statement "A request exceeding the injected limit MUST be rejected.", check `example.rejects-over-limit` (`layer: integration`) with `negative_control: { kind: seam, seam: "createLimiter({ policy })", sabotage: .invariant/sabotages/example/limit-unbounded.ts }`.
- `rules/flows/example.yaml` — flow `example-request`, `criticality: critical`, `owner: <owner>`, one step `s1` referencing `EXAMPLE-001`, and one flow check `example-request.completes` with `layer: e2e` (no negative control — PEND-10).
- `invariant-example/limiter.ts` — `export function createLimiter({ policy }) { return { request: (n) => n > policy.limit() ? { status: 413 } : { status: 200 } }; }`
- `invariant-example/limiter.test.ts` — two tagged checks (`@check example.rejects-over-limit`, `@rule EXAMPLE-001`, `@flow example-request/s1`; and `@check example-request.completes`, `@flow example-request`, `layer: e2e`), using extensionless relative imports (`"./limiter"`) so they run under any project's Vitest config.
- `.invariant/sabotages/example/limit-unbounded.ts` — `// @seam-alias invariant-example/limiter.ts` + `export function createLimiter() { return { request: () => ({ status: 200 }) }; }`
- `.invariant/config.yaml`, `.invariant/protection.ruleset.json`, `.invariant/protection-baseline.json`, `.github/workflows/invariant.yml`, and an appended CODEOWNERS block delimited by `# >>> invariant >>>` / `# <<< invariant <<<` covering the four protected paths plus `.github/CODEOWNERS`.
- `invariant-example/README.md` explaining the slice is a demo to delete once real rules exist.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/init-plan.test.ts
import { planInit } from "../../src/init/plan.js";

const input = (root: string, over: Partial<Parameters<typeof planInit>[0]> = {}) => ({
  root, owner: "@alice", adapter: "vitest", cliSetup: "npm i",
  invariantCmd: "npx --no-install invariant", invariantVersion: "0.1.0", baseline: G3_BASELINE, ...over,
});

it("creates the walking skeleton, the config, the workflow, the ruleset and the baseline", async () => {
  const plan = await planInit(input(await makeTmpRepo({})));
  expect(plan.writes.map((w) => w.path).sort()).toEqual([
    ".github/CODEOWNERS", ".github/workflows/invariant.yml", ".invariant/config.yaml",
    ".invariant/protection-baseline.json", ".invariant/protection.ruleset.json",
    ".invariant/sabotages/example/limit-unbounded.ts", "invariant-example/README.md",
    "invariant-example/limiter.test.ts", "invariant-example/limiter.ts",
    "rules/example.yaml", "rules/flows/example.yaml",
  ]);
});

it("renders a ruleset that requires exactly invariant-verdict pinned to the expected app", async () => {
  const plan = await planInit(input(await makeTmpRepo({})));
  const ruleset = JSON.parse(plan.writes.find((w) => w.path === ".invariant/protection.ruleset.json")!.content);
  expect(ruleset).toMatchObject({ target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } }, bypass_actors: [] });
  expect(ruleset.rules).toContainEqual({ type: "required_status_checks", parameters: { required_status_checks: [{ context: "invariant-verdict", integration_id: 15368 }], strict_required_status_checks_policy: true } });
  expect(ruleset.rules).toContainEqual({ type: "pull_request", parameters: { require_code_owner_review: true, required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_last_push_approval: false } });
});

it("never overwrites an existing file and appends the CODEOWNERS block once (idempotent)", async () => {
  const root = await makeTmpRepo({ "README.md": "mine", ".github/CODEOWNERS": "/docs/ @alice\n" });
  const first = await planInit(input(root));
  expect(first.writes.find((w) => w.path === "README.md")).toBeUndefined();
  expect(first.writes.find((w) => w.path === ".github/CODEOWNERS")).toMatchObject({ mode: "append-block" });
  expect(first.writes.find((w) => w.path === ".github/CODEOWNERS")!.content.match(/>>> invariant >>>/g)).toHaveLength(1);

  await applyInit(first); // helper: performs the writes, used only by tests
  const second = await planInit(input(root));
  expect(second.writes.filter((w) => w.mode === "create")).toEqual([]);
  expect(second.writes.find((w) => w.path === ".github/CODEOWNERS")).toMatchObject({ mode: "skip" });
});
```

`G3_BASELINE` and `applyInit` are local test helpers; the third test writes the plan to disk through `applyInit` so the second `planInit` really sees the first one's output.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/unit/init-plan.test.ts` → FAIL.

- [ ] **Step 3: Implement `planInit` and the command**

`planInit` is pure: it reads the current tree, computes the writes with `mode: "create" | "append-block" | "skip"`, and returns findings for anything it refuses to touch (an existing `rules/example.yaml`, an existing `EXAMPLE-001` id, an existing `>>> invariant >>>` block). The ruleset JSON is exactly the shape in Task 18's research: `target: "branch"`, `enforcement: "active"`, `conditions.ref_name.include: ["~DEFAULT_BRANCH"]`, the three rules above plus `non_fast_forward`, and an empty `bypass_actors`. `commands/init.ts` runs the doctor observation (it runs interactively, so the probe may be available), builds the `Baseline` from it — `recorded_class: "G3"` when the observation is unavailable — passes it to `planInit`, performs the writes, ends by printing the class, and returns `EXIT.GREEN`. A skipped file is reported, never silently ignored.

- [ ] **Step 4: Run the tests, then commit**

Run: `cd packages/cli && npm test` → PASS. Then `git add -A && git commit -m "feat(init): walking skeleton, config, workflow, ruleset, baseline"`

### Task 22: The gate demonstrated going red (walking skeleton, end to end)

**Files:**
- Test: `packages/cli/test/integration/walking-skeleton.test.ts`
- Create: `packages/cli/test/golden/walking-skeleton/{report.json,comment.md}`

**Interfaces:**
- Consumes: `runFixture`, `makeVitestRepo`, `spawnCli`.
- Produces: nothing new — this is the acceptance test for the whole plan.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/integration/walking-skeleton.test.ts
it("is green after init, and red with exit 1 when the rule's behaviour is broken", async () => {
  const root = await makeVitestRepo({ "package.json": JSON.stringify({ name: "demo", type: "module", private: true }) });
  expect((await spawnCli(["init", root, "--owner", "@alice", "--cli-setup", "true", "--invariant-cmd", `node ${CLI}`], { cwd: root })).exitCode).toBe(0);

  const green = await spawnCli(["verify", "--root", root, "--out", "invariant-report.json", "--comment", "invariant-comment.md"], { cwd: root });
  expect(green.exitCode).toBe(0);
  const report = JSON.parse(await readFile(path.join(root, "invariant-report.json"), "utf8"));
  expect(report.rules.find((r) => r.rule_id === "EXAMPLE-001")).toMatchObject({ verdict: "pass", sabotage_verified: false });
  expect(report.guarantee).toMatchObject({ class: "G3", negative_control: "declared-only" });

  // break the rule: the limiter stops consulting the injected policy
  await writeFile(path.join(root, "invariant-example/limiter.ts"), "export function createLimiter() { return { request: () => ({ status: 200 }) }; }\n");

  const red = await spawnCli(["verify", "--root", root], { cwd: root });
  expect(red.exitCode).toBe(1);
  expect(red.stdout).toContain("1 not green");
});

it("exits 2 when the registry is made invalid", async () => {
  // in the same temp repo: rewrite rules/example.yaml with status: enforced and checks: []
  expect((await spawnCli(["verify", "--root", root], { cwd: root })).exitCode).toBe(2);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npm run build && npx vitest run test/integration/walking-skeleton.test.ts`
Expected: FAIL on the first assertion — fix until the failures reflect unfinished wiring, not test bugs.

- [ ] **Step 3: Make it pass**

Iterate on the wiring only. If a step requires changing the design (an extra registry field, a weaker proof, a CLI flag not in the File Structure list), **stop and ask the human partner** instead of adapting the design.

- [ ] **Step 4: Run the full suite and the real dogfood command, then commit**

Run: `cd packages/cli && npm test` → PASS.
Run: `npm run dogfood` at the repo root → Expected: exit `0` with a report stating `0 enforced rules` (the plugin's own registry arrives in Task 23). Record the observed output in the commit message so the next task starts from a known state.
Then: `git add -A && git commit -m "test: walking skeleton green, red on break, exit 2 on invalid registry"`

### Task 23: Dogfooding — the plugin's own registry, seams, checks and sabotages

**Files:**
- Create: `rules/self.yaml`, `rules/flows/self-verify.yaml`, `.invariant/config.yaml`, `.invariant/sabotages/self/*.ts`, `.invariant/protection-baseline.json`, `.github/CODEOWNERS`
- Create: `packages/cli/test/self/self-001.test.ts` … `self-005.test.ts`
- Test: `packages/cli/test/integration/dogfood-registry.test.ts`

**Interfaces:**
- Consumes: `runVerify`, `buildVerifyContext`, `validateRegistry`, `loadRegistry`, `reconcile`, `createDiscoverySource`, `readEvent`, `immutabilityFinding`, `isProof`, `computeClass`, `runDoctorChecks`, `checkDeclared`, `createForgeProbe`, `loadConfig`, `makeVitestRepo`, `capability`/`flow` (Task 5's `test/helpers/registry.ts`).
- Produces: the five SELF rules and their tagged checks, each proving a behaviour of the plugin itself (spec §11). All five seams already exist (`discovery-source`, `check-runner`, `changed-files` from Tasks 4/7/12; `sabotage-source` from Task 14; `forge-probe` from Task 18) — this task adds no new seam modules.

- [ ] **Step 1: Write the dogfood registry**

`rules/self.yaml`: capability `self`, five rules with the spec's statements verbatim from §11:

| id | statement (§11) | check id | layer | seam module (sabotage `@seam-alias`) |
|---|---|---|---|---|
| `SELF-001` | The verifier MUST treat `not-run` as a failure for enforced rules. | `self.not-run-fails` | unit | `packages/cli/src/seams/check-runner.ts` |
| `SELF-002` | A check MUST NOT exist without a rule. | `self.no-orphan-checks` | unit | `packages/cli/src/seams/discovery-source.ts` |
| `SELF-003` | A rule change MUST NOT pass outside the flagged path. | `self.immutability` | unit | `packages/cli/src/seams/changed-files.ts` |
| `SELF-004` | A sabotaged run MUST be classified before it counts as proof. | `self.proof-decision` | unit | `packages/cli/src/seams/sabotage-source.ts` |
| `SELF-005` | The verifier MUST NOT report a guarantee class the environment does not support. | `self.guarantee-class` | integration | `packages/cli/src/seams/forge-probe.ts` |

All five are `status: enforced`, `criticality: critical` for SELF-005 and SELF-002 (they protect the gate itself) and `normal` for the others, `owners: [<the repo owner>]`, each with a `negative_control` of `kind: seam` pointing at `.invariant/sabotages/self/<name>.ts`. `rules/flows/self-verify.yaml`: flow `self-verify`, `criticality: critical`, steps `s1` (`SELF-001`, `SELF-002`), `s2` (`SELF-003`), `s3` (`SELF-004`, `SELF-005`), and a flow-level `e2e` check `self-verify.runs` (PEND-10: no negative control).

- [ ] **Step 2: Write the five checks (tagged, each driving the real composition root)**

**Rule for every SELF check:** obtain the subject through `buildVerifyContext(...)` or a seam factory, and create the hostile condition **in fixture files on disk**. Constructing a collaborator by hand would make the Phase 2 sabotage a no-op — and the design treats a no-op sabotage as a false red, never a false green (spec §7). Example:

```ts
// packages/cli/test/self/self-001.test.ts
// @check self.not-run-fails
// @rule SELF-001
// @flow self-verify/s1
import { describe, expect, it } from "vitest";
import { runVerify } from "../../src/commands/verify.js";
import { makeVitestRepo } from "../helpers/fixture.js";
import { capability } from "../helpers/registry.js";

describe("SELF-001", () => {
  it("treats a not-run check of an enforced rule as a failure", async () => {
    const root = await makeVitestRepo({
      "package.json": "{}",
      "rules/sales.yaml": capability("SALES-004"),          // draft-free, enforced, one check
      "src/sale.test.ts": `import { test } from "vitest";\n// @check sales.rejects-insufficient-stock\n// @rule SALES-004\ntest.skip("rejects insufficient stock", () => {});\n`,
      ".invariant/sabotages/sales/stock.ts": "// @seam-alias src/stock-policy.ts\nexport const policy = () => ({ available: () => Infinity });\n",
      "src/stock-policy.ts": "export const policy = () => ({ available: () => 1 });\n",
    });
    const { report, code } = await runVerify({ root });
    expect(report.rules.find((r) => r.rule_id === "SALES-004")?.verdict).toBe("not-run");
    expect(code).toBe(1);
  });
});
```

The other four follow the same shape:

- **SELF-002** — a temp repo whose tagged `@check` id has no registry declaration → `reconcile` reports `integrity.check_without_registry_declaration` and `runVerify` returns `2`.
- **SELF-003** — a temp **git** repo (`git init`, two commits, `git checkout -b feature`, then rewrite `rules/sales.yaml`) plus a committed PR event JSON (`--event`) and `--base <first sha>` → without the `invariant:rule-change` label `runVerify` returns `1` with `immutability.protected_path_changed`; the same repo with the label in the event returns `0`.
- **SELF-004** — `isProof` over all five `SabotageOutcome` variants, plus a report assertion: for a repo with enforced rules and green checks, `report.guarantee.negative_control === "declared-only"` and every rule has `sabotage_verified === false` (wire keys — `report` is the wire shape from Task 10).
- **SELF-005** — a temp repo with no protection and no CODEOWNERS coverage: obtain the observation via `createForgeProbe((await loadConfig(root)).config).observe(root)` (so the Phase 2 alias bites), run `runDoctorChecks`, and assert the class is `G3` and never `G1`; then assert `computeClass` yields `G1` for a synthetic complete observation with no protection findings, so the two directions are both pinned.

- [ ] **Step 3: Write the five sabotage files**

Each `.invariant/sabotages/self/<name>.ts` starts with `// @seam-alias <the seam module path>` and exports a replacement for that module's factory that makes the corresponding check fail *by assertion*. For example `check-runner.ts`'s sabotage returns a runner that reports everything as `pass` (so SELF-001's `not-run` expectation fails). These are declared now and applied from Phase 2 (PEND-8); `invariant negative` validates their declarations today.

- [ ] **Step 4: Write the offline dogfood test**

```ts
// packages/cli/test/integration/dogfood-registry.test.ts
it("the plugin's own registry validates, links and reconciles with zero findings", async () => {
  const root = REPO_ROOT;
  const { registry, findings } = await loadRegistry(root);
  const config = (await loadConfig(root)).config;
  expect(findings).toEqual([]);
  expect(validateRegistry(registry, { cwd: root, config })).toEqual([]);
  expect(reconcile(registry, await createDiscoverySource(config).discover(root))).toEqual([]);
  expect(registry.rules.map((r) => r.id).sort()).toEqual(["SELF-001", "SELF-002", "SELF-003", "SELF-004", "SELF-005"]);
  expect(checkDeclared(registry, root)).toEqual([]);
});
```

- [ ] **Step 5: Run the real dogfood command and commit**

Run: `npm test` → PASS.
Run: `npm run dogfood` → Expected: exit `0`, a report naming five green rules, `guarantee.class: "G3"` (this repo has no protection configured yet — correct and honest) and `guarantee.negative_control: "declared-only"`.
Run: `node packages/cli/dist/cli.js validate --json` → Expected: `{"findings": []}`.
Then: `git add -A && git commit -m "feat(dogfood): SELF-001..005 registry, seams, checks and declared sabotages"`

### Task 24: Corpus completeness and `--update` goldens

**Files:**
- Create: `packages/cli/test/integration/corpus.test.ts`
- Modify: `packages/cli/test/golden/**`

**Interfaces:**
- Consumes: `runFixture`, `expectGolden`.
- Produces: an assertion that every hostile case in spec §11 has a fixture and a golden.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/integration/corpus.test.ts
const CASES = [
  "orphan-rule", "orphan-check", "duplicate-tag", "not-run-check", "sabotage-missing-alias",
  "sabotage-does-not-compile", "no-op-sabotage", "invalid-registry", "upstream-cancelled",
  "flaky-check", "rule-changed-in-feature-pr", "rule-changed-flagged", "report-missing",
  "tag-case-mismatch", "empty-registry", "healthy-registry", "no-protection",
] as const;

it("every hostile case in spec §11 has a fixture with an expected exit code", async () => {
  for (const name of CASES) expect(await readFile(`test/fixtures/${name}/expected.json`, "utf8")).toBeTruthy();
});

it.each(CASES)("%s", async (name) => {
  const expected = JSON.parse(await readFile(`test/fixtures/${name}/expected.json`, "utf8"));
  const run = await runFixture(name, { args: expected.args });
  expect(run.exitCode).toBe(expected.exit_code);
  if (run.report) await expectGolden(name, normalizeReport(run.report), "report.json");
  if (run.comment) await expectGolden(name, run.comment, "comment.md");
});
```

Each fixture gains `expected.json`: `{ args: string[], exit_code: 0 | 1 | 2 }`.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/cli && npx vitest run test/integration/corpus.test.ts` → FAIL listing the missing fixtures.

- [ ] **Step 3: Add the missing fixtures**

`orphan-rule` (enforced rule with no check → exit 2), `sabotage-does-not-compile` and `no-op-sabotage` (both must pin **today's honest behaviour**: the sabotage file exists and declares `@seam-alias`, so the gate is `0` with `negative_control: "declared-only"`; add to each fixture's `README.md` that a *broken or no-op sabotage is not detectable in this delivery* and that Phase 2 changes `exit_code` to `1` — this is the visible record of the deferred hazard from spec §7). Also `no-protection` (a repo with no protection and a doctor run: `observed` G3).

- [ ] **Step 4: Generate the goldens, then commit**

Run: `cd packages/cli && UPDATE_GOLDENS=1 npx vitest run test/integration/corpus.test.ts`, then inspect **every** generated golden against the spec before accepting it, then `npx vitest run test/integration/corpus.test.ts` → PASS. Then `git add -A && git commit -m "test(corpus): full hostile fixture set with pinned goldens"`

### Task 25: README, adoption docs and the GitHub deployment

**Files:**
- Create: `README.md`, `docs/adopting.md`
- Manual: the GitHub repository, the imported ruleset, the recorded G1 baseline

**Interfaces:**
- Consumes: everything.
- Produces: the human-facing record of what is and is not guaranteed, plus verified evidence of a real red gate.

- [ ] **Step 1: Write `README.md`**

Sections, in order: what it is one paragraph; the guarantee-status table from the top of this plan (verbatim, including "the full guarantee of §7 arrives in Phase 2"); how the gate works (rule → check → verdict → gate); the DI requirement for adopters (spec §7: rule-bearing behaviour receives collaborators by injection, or the rule stays `draft`); the CLI commands; the exit codes; the guarantee classes with the warning that G3 must never be described as a guarantee. English (Global Constraints).

- [ ] **Step 2: Write `docs/adopting.md`**

The bootstrap sequence: install the CLI, `invariant init`, delete or replace the walking skeleton, import `.invariant/protection.ruleset.json` (`gh api --method POST repos/:owner/:repo/rulesets --input .invariant/protection.ruleset.json`), set the required check to `invariant-verdict` pinned to `github-actions`, add `INVARIANT_DOCTOR_TOKEN` (a fine-grained PAT with **Administration: read** and **Metadata: read** — the default `GITHUB_TOKEN` cannot read branch protection or rulesets), then `invariant doctor --record` to raise the baseline to G1. Include the code-owner-review requirement for the four protected paths and the `invariant:rule-change` label convention.

- [ ] **Step 3: Deploy on GitHub and record the evidence**

Ask the human partner for the GitHub account and repository name, then:
1. `gh repo create <owner>/invariant --public --source=. --push` (public → G1 available on GitHub Free).
2. `gh api --method POST repos/<owner>/invariant/rulesets --input .invariant/protection.ruleset.json`.
3. Confirm the ruleset requires exactly `invariant-verdict` pinned to the GitHub Actions app, with an empty bypass list.
4. Run `invariant doctor --strict` in CI and paste the output into the PR.

- [ ] **Step 4: Demonstrate the gate going red on a real PR**

On a branch, delete `sabotageVerified` handling in `src/verdict/proof.ts` in a way that breaks SELF-004's check; open a PR; record (screenshot or `gh run view`) that the `invariant-verdict` check is red. Close the PR without merging and delete the branch. Paste the check URL into the task's commit message.

- [ ] **Step 5: Commit the docs and the deployment record**

Run: `git add -A && git commit -m "docs: README, adoption guide and the verified G1 gate record"`

---

## Phase 2 preview (not in this plan)

Do not start these here: `Adapter.applySabotage` + `Adapter.classifyFailure`, the sabotaged run in isolated copies with no network and no secrets, `SabotageOutcome` producers, real `blocked` verdicts, JUnit report reading (PEND-11), the scheduled full run, and `invariant-scope` / `invariant status` / the agent skill from Phase 3 (spec §13 open questions 1 and 2 are already parameterised as `scope.mode` and `skill.distribution`).

## Self-Review

- **Spec coverage.** §5 → Tasks 2–3. §6 → Tasks 4–6, 8, 14. §7 → Tasks 9 (decision table), 14 (declaration checks), 23 (seams and declared sabotages); execution is Phase 2 and the guarantee-status block says so. §8 stages 1–8 → validate (1, 3, 4), run (2, 5), negative (6), verdict (7, 8), verify (all). §9.1/§9.2/§9.3 → Tasks 10, 17–20. §9.4 → Task 16. §10 → Tasks 21–22. §11 → Tasks 23 (dogfood) and 24 (corpus, including the adapter contract corpus). §12 rows → invalid registry (3), unparseable tags (5), deprecated check (8), no seam → draft (3), no-op sabotage (24, deferred and labelled), harness failure (9, deferred and labelled), flaky (13), upstream cancelled (11), report missing (11), protection absent (19–20), check not pinned (19), CODEOWNERS syntax (17, 19), bypass grew (19).
- **Type consistency.** `Finding`, `DiscoveredCheck`, `CheckResult`, `Verdict`, `SabotageOutcome`, `GuaranteeClass`, `DoctorObservation`, `Baseline`, `ExitCode` are each declared once (Tasks 2, 4, 5, 9, 10, 18, 19, 1) and only referenced afterwards. `computeClass` is declared once (Task 10) and called by Tasks 19, 20 and 23. The report's wire keys are snake_case everywhere, mapped in one place (`write.ts`, Task 10) — JSON assertions in Tasks 13 and 22 use `sabotage_verified`, `rule_id`, `negative_control`. `worst()`'s ordering is stated once, in Task 9.
- **Review Focus.** 1 → Task 2 (config defaults) and Task 3 (a fixture with no config). 2 → Task 10. 3 → Task 2 and 4. 4 → Task 8. 5 → Tasks 3, 10.
- **Proportion.** The plan is roughly twice the spec's length, most of it Interfaces and step commands; test bodies are sketches with the spec's exact values, not transcripts.
