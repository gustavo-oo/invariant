# invariant — Design

**Date:** 2026-10-17
**Status:** Approved in brainstorming (design review pending on this document)
**Working name:** `invariant` (renameable before first publish)

---

## 1. Problem and Intent

AI-assisted development makes it cheap to add features and equally cheap to silently break the
rules the business runs on. The failure is not "the code does not compile"; it is "a sale
completes with insufficient stock", "an invoice ships with the wrong tax rule", "the order flow
half-succeeds and leaves inconsistent state". Those breaks are invisible in a green test suite
until a user hits them in production.

The intent of `invariant` is a **mechanical guarantee**: a business rule that is declared
`enforced` cannot be broken by a change that reaches `main`, and a human can always tell *which*
rule failed, *which* check proved it, and *why*.

**Motivating instance (not a dependency):** an ERP for MEI / Simples Nacional, where the sales,
fiscal-emission and stock flows must not stop working and a break has legal and financial
consequences. The first deployment validates the design; nothing about MEI, tax law or Brazil
belongs in the plugin itself.

**Success criteria**

1. A change that breaks an enforced rule cannot merge — verified on a real repo, not asserted.
2. Every enforced rule has a check that is *proven able to fail* (Section 7); a check that cannot
   fail is not counted as proof.
3. Every verdict is traceable end to end: rule → check → run result → gate outcome.
4. Flows are readable as business artefacts: "checkout: green / emit-document: red", owned by a
   named owner.
5. Adding a feature does not require touching, weakening or deleting a rule — and cannot.

**Design principle inherited from the enforced-control literature:** a control the worker can
choose to ignore is not a control. The agent is a non-deterministic worker, so every guarantee is
placed where the agent cannot reach it — git protection, protected paths, and a verifier that
takes its input from CI rather than from the agent's report about itself.

## 2. Scope and Non-Goals

**In scope (dev-time and pre-merge only):**

- The rule/flow registry format and its validation.
- Discovery of tagged checks in the project's native test framework.
- The verifier CLI: integrity, immutability, execution, negative control, verdicts, reports.
- A reusable CI workflow plus the git-level protections that make the verdict non-bypassable.
- A thin agent skill that teaches working inside the system.
- One reference adapter (TypeScript / Node / Vitest) and the adapter interface for other stacks.

**Explicitly out of scope:**

- Runtime and production monitoring. No canaries, no health checks, no incident automation.
- Owning or replacing the project's test framework or test data.
- Domain knowledge (tax, inventory, fiscal documents). That belongs to the adopting instance.
- Automatic repair of flagged code, and automatic rule authoring.
- Deciding *which* rules matter. Humans declare rules; the tool verifies obedience.
- A dashboard or hosted service. Output is files, exit codes, and a PR comment.

## 3. Core Concepts

| Concept | Meaning |
|---|---|
| **Rule** | A declared, testable obligation about business behaviour. Owned by humans. |
| **Flow** | A declared, owned sequence of steps describing what the user experiences end to end. |
| **Check** | An executable test in the project's own framework that proves a rule holds (or that a flow works). Tagged with the ids it proves. |
| **Seam** | The injected collaborator through which rule-bearing behaviour receives the dependency the sabotage replaces. |
| **Sabotage** | A declared implementation of a seam that deliberately violates the rule, used to prove the check can fail. |
| **Verdict** | The computed state of a rule or flow: `pass` / `fail` / `not-run` / `flaky` / `blocked`. Orphans are integrity findings, not verdicts. |

**The invariant of the whole design:** `enforced` rules must have checks; checks must be able to
fail; proofs must come from CI, not from the agent's word.

## 4. Architecture

```
rules/              registry (source of truth)      ── depends on nothing
.invariant/         adapter config + sabotages/     ── depends on the project's test runner
packages/cli        verifier (validate/discover/run/verify/report)
  └─ adapter API    ── reference adapter: TypeScript + Vitest
ci/invariant.yml    reusable workflow + required aggregate check
skill/              agent skill (consumer of the above, never the enforcement)
```

**Dependency direction is one-way.** The registry is plain files that a human can read with no
tooling installed; the CLI depends on the adapter interface; the adapter depends on the project's
test framework; the skill depends on the registry and CLI. The registry must outlive the tooling.

Sabotage files live under `.invariant/sabotages/**`. Despite the dot-directory convention they are
committed, reviewed code, covered by CODEOWNERS and protected paths like any other proof.

**Component responsibilities**

| Component | Does | Must not do |
|---|---|---|
| Registry | Declare rules, flows, links, criticality, status, ownership | Execute anything, know a language |
| Adapter | Discover tagged checks, run them, classify failures, apply sabotages | Own the registry, decide policy |
| CLI | Validate, link, detect orphans, run, verify non-vacuity, roll up, report | Run production, invent rules, repair code |
| CI contract | Make the verdict required and fail-closed | Contain business logic |
| Agent skill | Teach the agent the workflow and the prohibitions | Be the enforcement mechanism |

## 5. Registry

Two declaration types, in version-controlled files under `rules/`: rules live in
`rules/<capability>.yaml`, flows in `rules/flows/<flow>.yaml`. Validated by a JSON Schema.

Both levels may declare `paths` (glob patterns). A **flow's** `paths` are the code that realises
the flow, and they drive `invariant-scope`; a **rule's** `paths` are the code that implements the
rule, and they scope incremental runs.

### 5.1 Rule

```yaml
capability: sales
rules:
  - id: SALES-004
    statement: "A sale MUST NOT be completed when stock is insufficient."
    rationale: "Prevents overselling and fiscal divergence between stock and issued documents."
    criticality: critical          # critical | normal
    status: enforced               # draft | enforced | deprecated
    owners: [team-commerce]
    paths:                         # code owned by this rule (scopes incremental runs)
      - apps/backend/supabase/functions/sales/**
    checks:
      - id: sales.rejects-insufficient-stock
        layer: integration         # unit | integration | e2e
        negative_control:
          kind: seam               # the only kind that satisfies a critical rule (Section 7)
          seam: buildApp({ stockPolicy })
          sabotage: .invariant/sabotages/sales/stock-policy.always-available.ts
```

**Validation rules (registry invalid ⇒ exit code 2):**

- `id` matches `^[A-Z][A-Z0-9]*-\d{3}$` and is unique across the registry.
- `statement` is non-empty, imperative, and names an observable obligation.
- `rationale` is non-empty (a rule nobody can justify is a rule nobody will defend).
- `status: enforced` requires at least one check and requires `owners`.
- `criticality: critical` + `status: enforced` requires `negative_control.kind: seam` on every check.
- `criticality: normal` + `status: enforced` requires a negative control at or above the
  counter-example floor (Section 7). A rule whose proof is weaker than seam sabotage declares it
  explicitly (`kind: counter-example` plus a `why_not_seam` field), so the weakened proof is
  visible in review.
- A rule with fewer than one check may only be `draft` or `deprecated`.
- `deprecated` requires `replaced_by` (or an explicit `retired: true`) — no silent deletions.

### 5.2 Flow

```yaml
flows:
  - id: checkout
    name: Complete a sale
    owner: team-commerce
    criticality: critical
    paths:
      - apps/backend/supabase/functions/sales/**
      - apps/interface/src/pages/sale/**
    steps:
      - id: s1
        name: Validate cart
        rules: [SALES-001, SALES-002]
      - id: s2
        name: Reserve stock
        rules: [SALES-004]
      - id: s3
        name: Persist sale
        rules: [SALES-007]
    checks:
      - id: checkout.completes-a-sale
        layer: e2e
```

**Validation rules:**

- Every referenced rule id exists; every step has at least one rule; step ids are unique per flow.
- A `critical` flow requires at least one `e2e` check. A flow check that is not `e2e` does not
  satisfy this.
- A flow's `checks` are flow-level end-to-end checks; per-rule checks stay on the rule.

### 5.3 Status as the pressure valve

`draft` declares knowledge without blocking. `enforced` is the only status that fails the gate, so
the gate never surprises anyone about a rule written minutes ago. `deprecated` keeps history and
exempts the rule, pointing at its replacement.

## 6. Checks and the Adapter

Checks are ordinary tests in the project's own framework, tagged so the adapter can find them:

```ts
// @rule SALES-004
// @flow checkout/s2
// @negative-control .invariant/sabotages/sales/stock-policy.always-available.ts
test("sale is rejected when stock is insufficient", async () => {
  const app = buildApp({ stockPolicy: availablePolicy() });          // the seam
  const res = await app.post("/sales", { lines: [{ sku: "A", qty: 3 }] }); // 1 in stock
  expect(res.status).toBe(409);
});
```

**Adapter discovery.** Tags in comments are the portable baseline. Where the stack allows it, the
adapter discovers from the AST (decorators, annotations, test-name conventions) and treats comment
tags as a fallback. Discovery must be deterministic and must report a tag that matches no test as
an orphan.

**Adapter interface (informative):**

```ts
interface Adapter {
  id: string;                                    // "vitest", "deno-test", ...
  discover(root: string): Promise<DiscoveredCheck[]>;
  run(checks: DiscoveredCheck[], opts: RunOpts): Promise<CheckResult[]>;
  readReports?(paths: string[]): Promise<CheckResult[]>;   // prefer existing JUnit/JSON output
  classifyFailure(r: CheckResult): "assertion" | "harness" | "timeout";
  applySabotage(s: SabotageSpec, workdir: string): Promise<SabotageOutcome>;
}
```

**Preferences the adapter must honour:**

- **Read before re-run.** If the project already produced machine-readable results in the same CI
  run, map them to rules instead of executing the suite twice. E2E is the most expensive layer and
  must not be paid for twice.
- **`not-run` is never green.** A check that was skipped, filtered out, not collected, or absent
  from the report is `not-run`. For an `enforced` rule, `not-run` fails the gate.
- **Flakiness is visible, not laundered.** A check that passes only after a retry is reported as
  `flaky`. For a `critical` rule, `flaky` is not green and requires a human decision. No silent
  retry-until-green.

**Adapter conformance** is proven by the plugin's own fixture corpus (Section 11), not by
documentation.

## 7. Negative Control — Injected Seam Only

Every `enforced` rule must be proven able to fail. The verifier runs each check twice:
**normal** (must pass) and **sabotaged** (must fail with an `assertion`-classified failure).

```ts
// .invariant/sabotages/sales/stock-policy.always-available.ts
export const availablePolicy = () => ({ available: () => Infinity });
```

**Only injected seams are supported.** There are no break flags in production code and no code
patches. The consequence is deliberate and must be stated to adopters: **rule-bearing behaviour
must receive its collaborators by injection** — a composition root at the application edge, module
boundaries for pure logic, and the ability to alias a module for the duration of a sabotaged run.

**When no seam exists, the rule is `blocked`, not green and not failed.** `blocked` is reported as
a first-class verdict with the missing seam named, so the fix is an explicit refactor instead of a
weaker proof. The plugin must never downgrade a proof silently.

**Grading by criticality** (approved trade-off):

| Rule | Required proof |
|---|---|
| `critical` + `enforced` | Declared seam sabotage; a `counter-example` substitution is not permitted |
| `normal` + `enforced` | Minimum counter-example scenario; declaring `counter-example` requires `why_not_seam` |
| `draft` | None (visible in reports, does not block) |

A **counter-example scenario** is a check that drives a violating input through the real code path
and asserts the rule is enforced (insufficient stock in, refusal out). It is cheap and needs no
injection, but it proves *input handling* only — it cannot detect a regression that leaves the
check green for the wrong reason. That is why it is the floor for `normal` rules and never
sufficient for `critical` ones.

A mutation engine may be added later as an optional adapter capability. It is not a requirement and
must never be the only proof.

**Two failure modes handled explicitly:**

1. *Sabotage that breaks everything.* If the sabotaged run fails because the module does not compile,
   does not import, or the harness errors, that is **not** proof. Only a failure classified as an
   assertion counts.
2. *No-op sabotage.* If the sabotage fails to apply, the check stays green and the verifier reports
   "check did not fail under sabotage" ⇒ the rule is not green. A missing or broken sabotage costs a
   false red, never a false green.

**Run policy.** Sabotaged runs execute in isolated copies with no secrets and no network. They are
re-executed when the check, the seam implementation, or the sabotage changes, plus on a scheduled
full run to catch drift; the check's own execution runs on every affected PR.

## 8. Verdict Pipeline

`invariant verify` runs eight stages; each is allowed to fail only for its own reason.

| # | Stage | Fails when |
|---|---|---|
| 1 | Load & validate registry | schema violation, duplicate id, dangling link, critical flow without an e2e check — the tool's error |
| 2 | Discover checks | adapter cannot parse tags deterministically |
| 3 | Integrity | orphan rule (enforced, no check), orphan check (tag with no rule), duplicate tag, unreachable tag |
| 4 | Immutability | registry, gate config or sabotages changed in a feature change outside the flagged, approved path |
| 5 | Execute | a check fails, or an enforced rule's check is `not-run` / `flaky` |
| 6 | Negative control | sabotaged run does not produce an `assertion` failure, or no seam is declared |
| 7 | Roll up | a rule is `fail` / `blocked` / `flaky`; a flow is red because a governing rule is not green or its flow check is not green |
| 8 | Report & exit | — |

**Roll-up rule:** a flow is green only if every governing rule is green **and** every flow-level
check is green. A single red governing rule makes the flow red, naming the step.

**Exit codes:**

| Code | Meaning | Reaction |
|---|---|---|
| `0` | All enforced rules and flows green | merge allowed |
| `1` | A rule or flow broke | the product is wrong; fix the code or the rule through the rule-change path |
| `2` | Registry invalid, adapter failed, or the verifier could not run | the gate is wrong; never merge on this |

**Reports.** `invariant-report.json` (machine: per-check results, classifications, sabotage
outcomes, per-rule and per-flow verdicts, registry hashes) and a PR comment (human table: rule,
flow, verdict, check, reason). Reports are pinned by golden files in the plugin's own tests.

## 9. CI Contract and Non-Bypassability

The plugin ships a reusable workflow; the project keeps its own build and test jobs.

| Job | Purpose | Notes |
|---|---|---|
| `invariant-registry` | schema, links, orphans, immutability diff vs. base | seconds; no project build needed |
| `invariant-checks` | map check results to rules and flows | prefers reading existing JUnit/JSON reports |
| `invariant-negative` | sabotaged runs in isolated copies | parallel; the expensive job |
| `invariant-scope` | PR touches a critical flow's declared paths without touching a rule or a check | advisory first, blocking once trusted |
| `invariant-verdict` | the single aggregate verdict | the only check required by branch protection |

**`invariant-verdict` exists as a separate job** because branch protection must require exactly one
stable check name. Requiring individual jobs means a rename silently removes the gate — and if an
agent can edit CI config, a rename is a bypass. `invariant-verdict` fails closed: any upstream job
that was cancelled, skipped, or never started yields a red verdict.

**Non-bypassability rests on git/forge mechanics, not on agent cooperation:**

- Protected paths requiring the flagged, CODEOWNERS-approved path: `rules/**`, `.invariant/**`,
  `.github/workflows/invariant.yml`, the adapter config, `.invariant/sabotages/**`.
- Agent/bot identities are subject to the same rulesets as humans (forge Rulesets, not classic
  branch protection, which behaves unexpectedly for bot identities).
- Negative control requires no secrets and no network: the guarantee never depends on a service
  being up.

**Honest limitation:** the plugin cannot enforce who approves a rule change. That is a forge
configuration; if it is not configured, the guarantee degrades to "the diff is visible", which this
document must not describe as mechanical.

## 10. Adoption

**Bootstrap.** `invariant init <repo>` writes: the registry skeleton, adapter config, the reusable
workflow, the protected-path entries, and a **walking skeleton** — one capability, one critical
flow, one or two rules with checks, seams and sabotages — so the gate is demonstrated failing on a
real repo before anyone trusts it.

**Top-down, not exhaustive.** Start from three critical flows (for the motivating ERP: complete a
sale, emit the fiscal document, move stock). Everything else stays `draft` or undeclared. Registry
completeness is not automatically verifiable — a flow nobody declared is invisible to the tool —
which is exactly why `invariant-scope` exists: a PR touching declared critical paths without
touching any rule or check is questioned at the gate instead of relying on memory.

**Graduation.** Draft rules become `enforced` when they have a check, a working seam sabotage, and
a green verdict. `invariant status` shows the draft backlog and the `blocked` rules (missing seams)
so they are worked instead of forgotten.

## 11. Testing `invariant` Itself

**Dogfooding.** The plugin's repo carries its own registry describing the plugin's rules —

- `SELF-001`: the verifier MUST treat `not-run` as failure for enforced rules.
- `SELF-002`: a check MUST NOT exist without a rule.
- `SELF-003`: a rule change MUST NOT pass outside the flagged path.
- `SELF-004`: a sabotaged run MUST be classified before it counts as proof.

— each with a tagged check and a seam sabotage. If the plugin's own gate can be bypassed, the design
is wrong.

**Fixture corpus.** Throwaway projects exercising hostile cases: orphan rules and orphan checks,
duplicate tags, a check that never runs, a sabotage that fails to compile, a no-op sabotage, a
registry made invalid, a cancelled upstream job, a flaky check, a rule changed in a feature PR. Each
fixture pins expected exit code and report output (golden files).

**Adapter contract tests.** Any adapter must pass the corpus; the TypeScript/Vitest adapter is the
reference implementation and is the first to pass.

## 12. Error Handling and Edge Cases

| Situation | Behaviour |
|---|---|
| Registry unreadable or invalid | exit 2; no rule verdicts are emitted (partial verdicts would be misleading) |
| Adapter cannot parse tags | exit 2; never guess a link |
| Check exists but its rule was deprecated | reported as `orphan` with a pointer to the replacement |
| Seam missing | rule `blocked`, named seam, exit 1; never downgraded |
| Sabotage fails to apply / no-op | rule not green (fail-closed); the verifier must detect application |
| Sabotage causes compile/setup error | not proof; classified `harness`, rule not green |
| Check flaky after retry | `flaky`; not green for `critical` rules |
| Upstream job skipped/cancelled | `invariant-verdict` red (fail-closed) |
| Rule change in a feature PR | exit 1 from `invariant-registry`; the change must go through the flagged path |
| Report artifact missing | `invariant-verdict` red; never infer success from absence |

## 13. Risks and Open Questions

| Risk | Mitigation / status |
|---|---|
| Immutability depends on forge configuration the tool cannot verify | Detected and reported by `init` as a checklist item; the spec states the limitation rather than implying a guarantee |
| Seam requirement stalls adoption on code that has no composition root | `blocked` verdicts are first-class and `invariant status` surfaces them; the plugin ships seam guidance per stack |
| Counter-example floor is weak for `normal` rules | Deliberate; declared in the registry via `why_not_seam`, so proof strength is auditable |
| Undeclared critical flows are invisible | `invariant-scope` + ownership; completeness is a human responsibility, stated plainly |
| Sabotage CI cost | Scope by change detection + scheduled full run |
| Tag parsing fragility across stacks | AST-first discovery, comment tags as fallback, conformance corpus |
| The tool becomes the project | Non-goals in Section 2; scope ends at the merge boundary |

**Open questions (not blocking the design):**

1. Whether `invariant-scope` starts advisory or blocking on first adoption.
2. Whether the agent skill ships as an OpenCode/Claude skill, an npm-installed skill directory, or both.

## 14. Phasing

Phasing is delivery order, not a weaker target. Until Phase 2 lands, the guarantee does not exist
and must not be claimed.

| Phase | Deliverable | Guarantee available |
|---|---|---|
| 0 | Registry schema + validator; tagged-check discovery + adapter interface; TS/Vitest reference adapter; verdict roll-up; `invariant-verdict` workflow; reports | "rules are declared and linked", not a guarantee |
| 1 | Positive control: enforced rules require checks; `not-run` and `flaky` handling; immutability diff | "no enforced rule merges without a green check" |
| 2 | Seam sabotage runs, failure classification, `blocked` verdicts, grading by criticality | the full guarantee of Section 7 |
| 3 | `invariant-scope`, `invariant status`, PR comment polish, agent skill | adoption ergonomics |

## 15. Decision Log

| # | Decision | Rationale |
|---|---|---|
| 1 | Generic, domain-agnostic plugin; MEI/Simples is only the motivating instance | Reusable asset; no domain contamination |
| 2 | Dev + CI only; no runtime, no incident automation | Explicit scope choice; production stays an ops concern |
| 3 | Core object is rule → check → gate, with traceability | Matches the stated need for a mechanical guarantee |
| 4 | Repo rule registry is the source of truth; humans own rules | Single auditable view of the business |
| 5 | Strict anti-bypass: immutable rules/config, orphans both ways, fail-closed, negative control | A bypassable gate is theatre |
| 6 | Flows are first-class, with step→rule mapping and required e2e checks for critical flows | Guarantees the sequence, not just the parts |
| 7 | Checks are tagged tests in the native framework; no DSL | Reuses real tooling; the plugin never becomes a test framework |
| 8 | Negative control by **injected seam only** | No bypass switch in production code, no brittle patches; accepts the DI constraint |
| 9 | Proof graded by criticality (sabotage for critical, counter-example floor for normal) | Cost allocation without weakening critical proofs |
| 10 | First reference adapter: TypeScript / Node / Vitest | Largest surface, strongest reference implementation |
| 11 | New publishable repo at `~/Projects/invariant` | Asset value; avoids contaminating the generic design with the first product |
| 12 | Approach A (guardrail kit) with a thin agent skill; Approach B never as enforcement | The Consort lesson: persuasion is not enforcement |
