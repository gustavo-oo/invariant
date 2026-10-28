import { describe, expect, it } from "vitest";
import type { CheckResult } from "../../src/adapter/api.js";
import type { DiscoveredCheck } from "../../src/discovery/types.js";
import type { CheckLayer, Flow, Registry, Rule, RuleStatus } from "../../src/registry/model.js";
import { computeVerdicts, worst } from "../../src/verdict/compute.js";
import { isProof } from "../../src/verdict/proof.js";
import type { SabotageOutcome } from "../../src/verdict/types.js";

interface RuleOptions {
  status?: RuleStatus;
  source?: { file: string; line: number };
  /** Overrides the default one `unit` check per id. */
  checks?: Array<{ id: string; layer: CheckLayer }>;
}

function rule(id: string, checkIds: string[], options: RuleOptions = {}): Rule {
  return {
    id,
    statement: `Statement for ${id}.`,
    rationale: `Rationale for ${id}.`,
    criticality: "normal",
    status: options.status ?? "enforced",
    checks: options.checks ?? checkIds.map((checkId) => ({ id: checkId, layer: "unit" })),
    source: options.source ?? { file: "rules/sales.yaml", line: 2 },
  };
}

function flow(id: string, steps: Array<{ id: string; rules: string[] }>, checkIds: string[] = []): Flow {
  return {
    id,
    name: `Flow ${id}`,
    owner: "team-commerce",
    criticality: "normal",
    steps: steps.map((step) => ({ id: step.id, name: `Step ${step.id}`, rules: step.rules })),
    checks: checkIds.map((checkId) => ({ id: checkId, layer: "e2e" })),
    source: { file: "rules/flows/checkout.yaml", line: 2 },
  };
}

function registry(rules: Rule[], flows: Flow[] = []): Registry {
  return { rules, flows, files: [] };
}

function discovered(checkId: string, rules: string[], extra: Partial<DiscoveredCheck> = {}): DiscoveredCheck {
  return {
    checkId,
    rules,
    flows: [],
    testName: `${checkId} test`,
    file: "test/sales.test.ts",
    line: 10,
    frameworkId: "vitest",
    runtimeId: `rt:${checkId}`,
    ...extra,
  };
}

function result(runtimeId: string, outcome: CheckResult["outcome"], message?: string): CheckResult {
  return message === undefined ? { runtimeId, outcome } : { runtimeId, outcome, message };
}

/** The proof every enforced check needs in the roll-up tests. */
function proofs(reg: Registry): Map<string, SabotageOutcome> {
  const outcomes = new Map<string, SabotageOutcome>();
  for (const rule of reg.rules) {
    for (const check of rule.checks) {
      outcomes.set(check.id, { status: "applied", classification: "assertion" });
    }
  }
  return outcomes;
}

function compute(
  reg: Registry,
  checks: DiscoveredCheck[],
  results: CheckResult[] = [],
  outcomes: Map<string, SabotageOutcome> = proofs(reg),
) {
  return computeVerdicts({ registry: reg, discovered: checks, results, outcomes });
}

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
    expect(worst("not-run", "flaky")).toBe("flaky");
    expect(worst("blocked", "flaky")).toBe("blocked");
    expect(worst("pass", "not-run")).toBe("not-run");
  });
});

describe("computeVerdicts", () => {
  it("makes a rule not green when any of its checks is not green", () => {
    const reg = registry([rule("SALES-004", ["sales.a", "sales.b"])]);
    const checks = [
      discovered("sales.a", ["SALES-004"], { file: "test/stock.test.ts", line: 12, runtimeId: "rt-a" }),
      discovered("sales.b", ["SALES-004"], { file: "test/stock.test.ts", line: 40, runtimeId: "rt-b" }),
    ];

    const verdicts = compute(reg, checks, [result("rt-a", "pass"), result("rt-b", "flaky")]);

    expect(verdicts.checks).toHaveLength(2);
    expect(verdicts.checks[0]).toEqual({
      checkId: "sales.a",
      ruleIds: ["SALES-004"],
      flowRefs: [],
      layer: "unit",
      file: "test/stock.test.ts",
      line: 12,
      runtimeId: "rt-a",
      verdict: "pass",
      reason: "check.passed",
      negativeControl: { status: "applied", classification: "assertion" },
    });
    expect(verdicts.checks[1]).toMatchObject({ checkId: "sales.b", verdict: "flaky", reason: "check.flaky" });

    expect(verdicts.rules).toHaveLength(1);
    expect(verdicts.rules[0]).toMatchObject({
      ruleId: "SALES-004",
      capability: "sales",
      criticality: "normal",
      status: "enforced",
      verdict: "flaky",
      reason: "check.flaky",
      checkIds: ["sales.a", "sales.b"],
      sabotageVerified: true,
    });
  });

  it("makes a rule not-run when one check is not-run even if another passed", () => {
    const reg = registry([rule("SALES-004", ["sales.a", "sales.b"])]);
    const checks = [
      discovered("sales.a", ["SALES-004"], { runtimeId: "rt-a" }),
      discovered("sales.b", ["SALES-004"], { runtimeId: "rt-b" }),
    ];

    const verdicts = compute(reg, checks, [result("rt-a", "pass"), result("rt-b", "not-run")]);

    expect(verdicts.rules[0]).toMatchObject({
      verdict: "not-run",
      reason: "check.not_run",
      checkIds: ["sales.a", "sales.b"],
    });
  });

  it("makes a flow red and names the step whose governing rule is not green", () => {
    const reg = registry(
      [rule("SALES-001", ["sales.a"]), rule("SALES-002", ["sales.b"])],
      [flow("checkout", [
        { id: "s1", rules: ["SALES-001"] },
        { id: "s2", rules: ["SALES-002"] },
      ])],
    );
    const checks = [
      discovered("sales.a", ["SALES-001"], { runtimeId: "rt-a" }),
      discovered("sales.b", ["SALES-002"], { runtimeId: "rt-b" }),
    ];

    const verdicts = compute(reg, checks, [result("rt-a", "pass"), result("rt-b", "fail", "expected 0")]);

    expect(verdicts.rules.map((verdict) => [verdict.ruleId, verdict.verdict, verdict.reason])).toEqual([
      ["SALES-001", "pass", "check.passed"],
      ["SALES-002", "fail", "check.failed"],
    ]);
    expect(verdicts.checks[1]?.message).toBe("expected 0");

    expect(verdicts.flows).toHaveLength(1);
    expect(verdicts.flows[0]).toMatchObject({
      flowId: "checkout",
      criticality: "normal",
      verdict: "fail",
      reason: "governing_rule_not_green",
      checkIds: [],
    });
    expect(verdicts.flows[0]?.steps).toEqual([
      { stepId: "s1", verdict: "pass", reason: "governing_rule_green", ruleIds: ["SALES-001"] },
      { stepId: "s2", verdict: "fail", reason: "governing_rule_not_green", ruleIds: ["SALES-002"] },
    ]);
  });

  it("makes a flow red when a flow-level check is not green and no rule is", () => {
    const reg = registry(
      [rule("SALES-001", ["sales.a"])],
      [flow("checkout", [{ id: "s1", rules: ["SALES-001"] }], ["checkout.e2e"])],
    );
    const checks = [
      discovered("sales.a", ["SALES-001"], { runtimeId: "rt-a" }),
      discovered("checkout.e2e", [], {
        runtimeId: "rt-e2e",
        file: "test/checkout.e2e.test.ts",
        line: 22,
      }),
    ];

    const verdicts = compute(reg, checks, [
      result("rt-a", "pass"),
      result("rt-e2e", "fail", "button not found"),
    ]);

    expect(verdicts.rules[0]?.verdict).toBe("pass");
    expect(verdicts.flows[0]).toMatchObject({
      verdict: "fail",
      reason: "flow_check_not_green",
      checkIds: ["checkout.e2e"],
    });
    expect(verdicts.flows[0]?.steps).toEqual([
      { stepId: "s1", verdict: "pass", reason: "governing_rule_green", ruleIds: ["SALES-001"] },
    ]);
    expect(verdicts.checks[1]).toMatchObject({
      checkId: "checkout.e2e",
      layer: "e2e",
      verdict: "fail",
      reason: "check.failed",
      message: "button not found",
    });
  });

  it("prefers the governing rule over a tied flow-level check (R42)", () => {
    const reg = registry(
      [rule("SALES-001", ["sales.a"])],
      [flow("checkout", [{ id: "s1", rules: ["SALES-001"] }], ["checkout.e2e"])],
    );
    const checks = [
      discovered("sales.a", ["SALES-001"], { runtimeId: "rt-a" }),
      discovered("checkout.e2e", [], { runtimeId: "rt-e2e" }),
    ];

    const verdicts = compute(reg, checks, [result("rt-a", "fail"), result("rt-e2e", "fail")]);

    expect(verdicts.flows[0]).toMatchObject({
      verdict: "fail",
      reason: "governing_rule_not_green",
    });
  });

  it("makes a flow green when its governing rules and flow-level checks are green", () => {
    const reg = registry(
      [rule("SALES-001", ["sales.a"])],
      [flow("checkout", [{ id: "s1", rules: ["SALES-001"] }], ["checkout.e2e"])],
    );
    const checks = [
      discovered("sales.a", ["SALES-001"], { runtimeId: "rt-a" }),
      discovered("checkout.e2e", [], { runtimeId: "rt-e2e" }),
    ];

    const verdicts = compute(reg, checks, [result("rt-a", "pass"), result("rt-e2e", "pass")]);

    expect(verdicts.flows[0]).toMatchObject({ verdict: "pass", reason: "flow_passed" });
    expect(verdicts.flows[0]?.steps).toEqual([
      { stepId: "s1", verdict: "pass", reason: "governing_rule_green", ruleIds: ["SALES-001"] },
    ]);
  });

  it("keeps a flow not-run when a declared flow-level check has no discovered test", () => {
    const reg = registry(
      [rule("SALES-001", ["sales.a"])],
      [flow("checkout", [{ id: "s1", rules: ["SALES-001"] }], ["checkout.e2e"])],
    );
    const checks = [discovered("sales.a", ["SALES-001"], { runtimeId: "rt-a" })];

    const verdicts = compute(reg, checks, [result("rt-a", "pass")]);

    expect(verdicts.flows[0]).toMatchObject({
      verdict: "not-run",
      reason: "flow_check_not_green",
      checkIds: ["checkout.e2e"],
    });
    expect(verdicts.flows[0]?.steps).toEqual([
      { stepId: "s1", verdict: "pass", reason: "governing_rule_green", ruleIds: ["SALES-001"] },
    ]);
  });

  it("does not let a draft or deprecated rule redden its step or flow (R44)", () => {
    const checks = [discovered("sales.a", ["SALES-001"], { runtimeId: "rt-a" })];
    const results = [result("rt-a", "fail")];
    const checkout = [flow("checkout", [{ id: "s1", rules: ["SALES-001"] }])];

    for (const status of ["draft", "deprecated"] as const) {
      const verdicts = compute(
        registry([rule("SALES-001", ["sales.a"], { status })], checkout),
        checks,
        results,
      );
      // The rule is still reported red; only its gate participation is withheld.
      expect(verdicts.rules[0]).toMatchObject({ status, verdict: "fail", reason: "check.failed" });
      expect(verdicts.flows[0]).toMatchObject({ verdict: "pass", reason: "flow_passed" });
      expect(verdicts.flows[0]?.steps).toEqual([
        { stepId: "s1", verdict: "pass", reason: "governing_rule_green", ruleIds: ["SALES-001"] },
      ]);
    }

    const enforced = compute(registry([rule("SALES-001", ["sales.a"])], checkout), checks, results);
    expect(enforced.flows[0]).toMatchObject({ verdict: "fail", reason: "governing_rule_not_green" });
    expect(enforced.flows[0]?.steps[0]).toMatchObject({
      verdict: "fail",
      reason: "governing_rule_not_green",
    });
  });

  it("blocks green enforced checks whose outcomes are not proof", () => {
    const reg = registry([
      rule("SALES-001", ["sales.a", "sales.b"]),
      rule("SALES-002", ["sales.b"]),
    ]);
    const checks = [
      discovered("sales.a", ["SALES-001"], { runtimeId: "rt-a" }),
      discovered("sales.b", ["SALES-001", "SALES-002"], { runtimeId: "rt-b" }),
    ];
    const outcomes = new Map<string, SabotageOutcome>([
      ["sales.a", { status: "not-executed" }],
      ["sales.b", { status: "not-executed" }],
    ]);

    const verdicts = compute(reg, checks, [result("rt-a", "pass"), result("rt-b", "pass")], outcomes);

    expect(verdicts.checks.map((check) => [check.verdict, check.reason])).toEqual([
      ["blocked", "check.blocked"],
      ["blocked", "check.blocked"],
    ]);
    expect(verdicts.rules.map((verdict) => verdict.verdict)).toEqual(["blocked", "blocked"]);
    expect(verdicts.rules.map((verdict) => verdict.sabotageVerified)).toEqual([false, false]);
    // R39: a check tagged with both rules is attributed to both.
    expect(verdicts.rules.map((verdict) => verdict.checkIds)).toEqual([
      ["sales.a", "sales.b"],
      ["sales.b"],
    ]);
  });

  it("blocks a single green check whose sabotage is a no-op", () => {
    const reg = registry([rule("SALES-004", ["sales.a"])]);
    const checks = [discovered("sales.a", ["SALES-004"])];
    const outcomes = new Map<string, SabotageOutcome>([["sales.a", { status: "not-applied" }]]);

    const verdicts = compute(reg, checks, [result("rt:sales.a", "pass")], outcomes);

    expect(verdicts.checks[0]).toMatchObject({ checkId: "sales.a", verdict: "blocked", reason: "check.blocked" });
    expect(verdicts.rules[0]).toMatchObject({
      ruleId: "SALES-004",
      verdict: "blocked",
      reason: "check.blocked",
      sabotageVerified: false,
    });
  });

  it("leaves a draft rule green without proof (it does not gate)", () => {
    const reg = registry([rule("SALES-005", ["sales.draft"], { status: "draft" })]);
    const checks = [discovered("sales.draft", ["SALES-005"])];
    const outcomes = new Map<string, SabotageOutcome>([["sales.draft", { status: "not-applied" }]]);

    const verdicts = compute(reg, checks, [result("rt:sales.draft", "pass")], outcomes);

    expect(verdicts.checks[0]?.verdict).toBe("pass");
    expect(verdicts.rules[0]).toMatchObject({ status: "draft", verdict: "pass", sabotageVerified: false });
  });

  it("marks sabotageVerified true only when every attributed check is a proof", () => {
    const reg = registry([
      rule("SALES-001", ["sales.a", "sales.b"]),
      rule("SALES-002", ["sales.c"]),
    ]);
    const checks = [
      discovered("sales.a", ["SALES-001"], { runtimeId: "rt-a" }),
      discovered("sales.b", ["SALES-001"], { runtimeId: "rt-b" }),
      discovered("sales.c", ["SALES-002"], { runtimeId: "rt-c" }),
    ];
    const results = [result("rt-a", "pass"), result("rt-b", "pass"), result("rt-c", "pass")];

    // One check is not a proof, so the rule is not proven able to fail.
    const partial = new Map<string, SabotageOutcome>([
      ["sales.a", { status: "applied", classification: "assertion" }],
      ["sales.b", { status: "not-executed" }],
      ["sales.c", { status: "applied", classification: "harness" }],
    ]);
    expect(compute(reg, checks, results, partial).rules.map((verdict) => verdict.sabotageVerified)).toEqual([
      false,
      false,
    ]);

    const complete = new Map<string, SabotageOutcome>([
      ["sales.a", { status: "applied", classification: "assertion" }],
      ["sales.b", { status: "applied", classification: "assertion" }],
      ["sales.c", { status: "applied", classification: "assertion" }],
    ]);
    expect(compute(reg, checks, results, complete).rules.map((verdict) => verdict.sabotageVerified)).toEqual([
      true,
      true,
    ]);
  });

  it("pairs results by index when runChecks returned one per check (R40)", () => {
    const reg = registry([rule("SALES-001", ["sales.a"]), rule("SALES-002", ["sales.b"])]);
    const checks = [
      discovered("sales.a", ["SALES-001"], { runtimeId: "rt-a" }),
      discovered("sales.b", ["SALES-002"], { runtimeId: "rt-b" }),
    ];

    // The contract is input order, so swapped runtime ids prove index pairing
    // wins over matching by runtimeId when the counts agree.
    const verdicts = compute(reg, checks, [result("rt-b", "pass"), result("rt-a", "fail")]);

    expect(verdicts.checks.map((verdict) => [verdict.checkId, verdict.verdict])).toEqual([
      ["sales.a", "pass"],
      ["sales.b", "fail"],
    ]);
  });

  it("falls back to runtimeId when the result count does not match, never inventing a pass", () => {
    const reg = registry([rule("SALES-001", ["sales.a", "sales.b", "sales.c"])]);
    const checks = [
      discovered("sales.a", ["SALES-001"], { runtimeId: "rt-a" }),
      discovered("sales.b", ["SALES-001"], { runtimeId: "rt-b" }),
      discovered("sales.c", ["SALES-001"], { runtimeId: "rt-c" }),
    ];

    const verdicts = compute(reg, checks, [
      result("rt-b", "pass"),
      result("rt-a", "fail", "assertion failed"),
      result("rt-ghost", "pass"),
      result("rt-other-ghost", "pass"),
    ]);

    expect(verdicts.checks.map((verdict) => [verdict.checkId, verdict.verdict, verdict.reason])).toEqual([
      ["sales.a", "fail", "check.failed"],
      ["sales.b", "pass", "check.passed"],
      ["sales.c", "not-run", "check.not_run"],
    ]);
    expect(verdicts.rules[0]).toMatchObject({ verdict: "fail", reason: "check.failed" });
  });

  it("consumes each unmatched result at most once for duplicate runtime ids", () => {
    const reg = registry([rule("SALES-001", ["sales.a", "sales.b"])]);
    const checks = [
      discovered("sales.a", ["SALES-001"], { runtimeId: "rt-shared" }),
      discovered("sales.b", ["SALES-001"], { runtimeId: "rt-shared" }),
    ];

    const verdicts = compute(reg, checks, [result("rt-shared", "pass")]);

    expect(verdicts.checks.map((verdict) => [verdict.checkId, verdict.verdict])).toEqual([
      ["sales.a", "pass"],
      ["sales.b", "not-run"],
    ]);
  });

  it("reports a rule with no attributed check as fail with rule_no_check", () => {
    const reg = registry([
      rule("SALES-001", ["sales.a"]),
      // Declared but not discovered: integrity already fails the repo, and the
      // verdict stays red as belt-and-braces rather than a vacuous green.
      rule("SALES-002", ["sales.b"]),
      rule("SALES-003", [], { status: "draft" }),
    ]);
    const checks = [discovered("sales.a", ["SALES-001"])];

    const verdicts = compute(reg, checks, [result("rt:sales.a", "pass")]);

    expect(verdicts.rules.map((verdict) => [verdict.ruleId, verdict.verdict, verdict.reason, verdict.checkIds])).toEqual([
      ["SALES-001", "pass", "check.passed", ["sales.a"]],
      ["SALES-002", "fail", "rule_no_check", []],
      ["SALES-003", "fail", "rule_no_check", []],
    ]);
  });

  it("still reports draft and deprecated rules with a computed verdict", () => {
    const reg = registry([
      rule("SALES-001", ["sales.a"]),
      rule("SALES-002", ["sales.b"], { status: "draft" }),
      rule("SALES-003", ["sales.c"], { status: "deprecated" }),
    ]);
    const checks = [
      discovered("sales.a", ["SALES-001"], { runtimeId: "rt-a" }),
      discovered("sales.b", ["SALES-002"], { runtimeId: "rt-b" }),
      discovered("sales.c", ["SALES-003"], { runtimeId: "rt-c" }),
    ];

    const verdicts = compute(reg, checks, [
      result("rt-a", "pass"),
      result("rt-b", "fail"),
      result("rt-c", "pass"),
    ]);

    expect(verdicts.rules.map((verdict) => [verdict.status, verdict.verdict])).toEqual([
      ["enforced", "pass"],
      ["draft", "fail"],
      ["deprecated", "pass"],
    ]);
  });

  it("returns empty arrays for an empty registry, discovery and result set", () => {
    expect(compute(registry([]), [])).toEqual({ checks: [], rules: [], flows: [] });
    expect(compute(registry([]), [], [result("rt-ghost", "pass")])).toEqual({
      checks: [],
      rules: [],
      flows: [],
    });
  });

  it("omits layer for a check no rule or flow declares and never throws on extra results", () => {
    const verdicts = compute(registry([]), [discovered("ghost.check", [], { runtimeId: "rt-ghost" })], [
      result("rt-other", "pass"),
      result("rt-ghost", "pass"),
    ]);

    expect(verdicts.checks).toHaveLength(1);
    expect(verdicts.checks[0]).toMatchObject({
      checkId: "ghost.check",
      verdict: "pass",
      reason: "check.passed",
    });
    expect("layer" in verdicts.checks[0]!).toBe(false);
    expect(verdicts.rules).toEqual([]);
    expect(verdicts.flows).toEqual([]);
  });
});
