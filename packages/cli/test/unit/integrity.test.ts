import { describe, expect, it } from "vitest";
import type { DiscoveredCheck, DiscoveryError, DiscoveryResult } from "../../src/discovery/types.js";
import { reconcile } from "../../src/registry/integrity.js";
import type { CheckDecl, Flow, Registry, Rule, RuleStatus } from "../../src/registry/model.js";

/**
 * `sabotage` is a reserved key, not a rule id: every check the helper builds
 * gets that sabotage path. It exists so the negative-control case reads as one
 * registry, not a second helper.
 */
interface RuleMap {
  [ruleId: string]: string[] | string;
}

interface FlowSpec {
  flow: string;
  /** Step id -> the rules the step lists. */
  steps: Record<string, string[]>;
  /** Flow-level check ids the flow declares. */
  checks?: string[];
}

interface RegistryOptions {
  status?: RuleStatus;
}

/** An in-memory registry: rule id -> declared check ids, plus an optional flow. */
function reg(rules: RuleMap, flow?: FlowSpec, options: RegistryOptions = {}): Registry {
  const sabotage = typeof rules["sabotage"] === "string" ? rules["sabotage"] : undefined;
  const status = options.status ?? "enforced";
  const built: Rule[] = [];

  for (const [ruleId, checkIds] of Object.entries(rules)) {
    if (ruleId === "sabotage" || !Array.isArray(checkIds)) continue;
    built.push(buildRule(ruleId, checkIds, sabotage, status));
  }

  return {
    rules: built,
    flows: flow === undefined ? [] : [buildFlow(flow)],
    files: [],
  };
}

function buildRule(id: string, checkIds: string[], sabotage: string | undefined, status: RuleStatus): Rule {
  const checks: CheckDecl[] = checkIds.map((checkId) => {
    const decl: CheckDecl = { id: checkId, layer: "unit" };
    if (sabotage !== undefined) {
      decl.negativeControl = { kind: "seam", seam: "buildApp({ stockPolicy })", sabotage };
    }
    return decl;
  });
  return {
    id,
    statement: `Statement for ${id}.`,
    rationale: `Rationale for ${id}.`,
    criticality: "normal",
    status,
    checks,
    source: { file: "rules/sales.yaml", line: 2 },
  };
}

function buildFlow(spec: FlowSpec): Flow {
  return {
    id: spec.flow,
    name: "Complete a sale",
    owner: "team-commerce",
    criticality: "normal",
    steps: Object.entries(spec.steps).map(([id, rules]) => ({ id, name: `Step ${id}`, rules })),
    checks: (spec.checks ?? []).map((id) => ({ id, layer: "e2e" })),
    source: { file: "rules/flows/checkout.yaml", line: 2 },
  };
}

/**
 * A `DiscoveryResult` from partial checks. Each entry gets a distinct file line
 * and runtime id by default, so two entries are two distinct tests — duplicate
 * discovery shapes must be asked for explicitly.
 */
function disc(checks: Array<Partial<DiscoveredCheck>>, errors: DiscoveryError[] = []): DiscoveryResult {
  return {
    checks: checks.map((partial, index) => ({
      checkId: "sales.a",
      rules: [],
      flows: [],
      testName: `test ${index}`,
      file: "src/sales.test.ts",
      line: 10 + index,
      frameworkId: "vitest",
      runtimeId: `suite > test ${index}`,
      ...partial,
    })),
    errors,
  };
}

function codes(registry: Registry, discovery: DiscoveryResult): string[] {
  return reconcile(registry, discovery)
    .map((finding) => finding.code)
    .sort();
}

describe("reconcile", () => {
  it("reports both orphan directions, duplicate tags and tag/registry mismatches", () => {
    expect(codes(reg({ "SALES-004": ["sales.a"] }), disc([]))).toEqual(["integrity.rule_without_discovered_check"]);
    expect(codes(reg({ "SALES-004": ["sales.a"] }), disc([{ checkId: "sales.x", rules: ["SALES-999"] }]))).toEqual([
      "integrity.check_without_registry_declaration",
      "integrity.rule_without_discovered_check",
      "integrity.unknown_rule_id",
    ]);
    expect(
      codes(
        reg({ "SALES-004": ["sales.a"] }),
        disc([
          { checkId: "sales.a", rules: ["SALES-004"] },
          { checkId: "sales.a", rules: ["SALES-004"] },
        ]),
      ),
    ).toEqual(["integrity.duplicate_check_tag"]);
    // @rule sales-004 (lower case) must not match SALES-004.
    expect(codes(reg({ "SALES-004": ["sales.a"] }), disc([{ checkId: "sales.a", rules: ["sales-004"] }]))).toContain(
      "integrity.unknown_rule_id",
    );
  });

  it("reports a @negative-control path that disagrees with the registry (PEND-4)", () => {
    expect(
      codes(
        reg({ "SALES-004": ["sales.a"], sabotage: ".invariant/sabotages/sales/one.ts" }),
        disc([{ checkId: "sales.a", rules: ["SALES-004"], negativeControl: ".invariant/sabotages/sales/two.ts" }]),
      ),
    ).toContain("integrity.negative_control_mismatch");
  });

  it("reports a @flow step that does not exist or does not carry the tagged rule", () => {
    const r = reg({ "SALES-004": ["sales.a"] }, { flow: "checkout", steps: { s1: ["SALES-002"] } });
    expect(
      codes(r, disc([{ checkId: "sales.a", rules: ["SALES-004"], flows: [{ flow: "checkout", step: "s9" }] }])),
    ).toContain("integrity.unknown_step");
    expect(
      codes(r, disc([{ checkId: "sales.a", rules: ["SALES-004"], flows: [{ flow: "checkout", step: "s1" }] }])),
    ).toContain("integrity.rule_not_in_step");
    expect(codes(r, disc([{ checkId: "sales.a", rules: ["SALES-004"], flows: [{ flow: "nope" }] }]))).toContain(
      "integrity.unknown_flow",
    );
  });

  it("accepts a @negative-control tag that equals the declared sabotage path", () => {
    expect(
      codes(
        reg({ "SALES-004": ["sales.a"], sabotage: ".invariant/sabotages/sales/one.ts" }),
        disc([{ checkId: "sales.a", rules: ["SALES-004"], negativeControl: ".invariant/sabotages/sales/one.ts" }]),
      ),
    ).toEqual([]);
  });

  it("is silent when no @negative-control tag is present (the registry path is authoritative)", () => {
    expect(codes(reg({ "SALES-004": ["sales.a"], sabotage: ".invariant/sabotages/sales/one.ts" }), disc([{ checkId: "sales.a", rules: ["SALES-004"] }]))).toEqual([]);
  });

  it("flags the same @rule twice within one test, but not the same rule on two tests", () => {
    expect(codes(reg({ "SALES-004": ["sales.a"] }), disc([{ checkId: "sales.a", rules: ["SALES-004", "SALES-004"] }]))).toEqual([
      "integrity.duplicate_check_tag",
    ]);
    // Two tests carrying the same @rule is how a rule gets several checks.
    expect(
      codes(
        reg({ "SALES-004": ["sales.a", "sales.b"] }),
        disc([
          { checkId: "sales.a", rules: ["SALES-004"] },
          { checkId: "sales.b", rules: ["SALES-004"] },
        ]),
      ),
    ).toEqual([]);
  });

  it("exempts a draft rule that declares no check, and flags a draft rule that declares one", () => {
    expect(codes(reg({ "SALES-009": [] }, undefined, { status: "draft" }), disc([]))).toEqual([]);
    expect(codes(reg({ "SALES-009": ["sales.z"] }, undefined, { status: "draft" }), disc([]))).toEqual([
      "integrity.rule_without_discovered_check",
    ]);
  });

  it("names every missing check id in the orphan-rule finding", () => {
    const [finding] = reconcile(reg({ "SALES-004": ["sales.a", "sales.b"] }), disc([]));
    expect(finding?.code).toBe("integrity.rule_without_discovered_check");
    expect(finding?.ruleId).toBe("SALES-004");
    expect(finding?.message).toContain('"sales.a"');
    expect(finding?.message).toContain('"sales.b"');
    expect(finding?.file).toBe("rules/sales.yaml");
    expect(finding?.line).toBe(2);
  });

  it("treats flow-level checks as registry declarations", () => {
    const draft = (): Registry =>
      reg(
        { "SALES-009": [] },
        { flow: "checkout", steps: { s1: ["SALES-009"] }, checks: ["checkout.completes"] },
        { status: "draft" },
      );
    expect(codes(draft(), disc([{ checkId: "checkout.completes", flows: [{ flow: "checkout" }] }]))).toEqual([]);
    expect(codes(draft(), disc([{ checkId: "checkout.other" }]))).toEqual(["integrity.check_without_registry_declaration"]);
  });

  it("reports a duplicate runtime id as a discovery error naming both checks (R35)", () => {
    const findings = reconcile(
      reg({ "SALES-004": ["sales.a", "sales.b"] }),
      disc([
        { checkId: "sales.a", rules: ["SALES-004"], runtimeId: "suite > same" },
        { checkId: "sales.b", rules: ["SALES-004"], runtimeId: "suite > same" },
      ]),
    );
    expect(findings.map((finding) => finding.code)).toEqual(["integrity.discovery_error"]);
    expect(findings[0]?.message).toContain('"sales.a"');
    expect(findings[0]?.message).toContain('"sales.b"');
    expect(findings[0]?.message).toContain('"suite > same"');
  });

  it("passes discovery errors through as gate findings", () => {
    const findings = reconcile(
      reg({ "SALES-009": [] }, undefined, { status: "draft" }),
      disc([], [{ file: "src/broken.test.ts", line: 3, message: "could not parse: ')' expected" }]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "integrity.discovery_error",
      file: "src/broken.test.ts",
      line: 3,
      message: "could not parse: ')' expected",
    });
  });

  it("returns findings in a stable order: file, line, code, message", () => {
    const findings = reconcile(
      reg({ "AAA-001": ["a.one"], "BBB-002": ["b.two"] }),
      disc(
        [{ checkId: "c.three", rules: ["ZZZ-999"], flows: [{ flow: "nope" }] }],
        [{ file: "src/a.test.ts", line: 2, message: "broken" }],
      ),
    );
    expect(findings.map((finding) => `${finding.file}:${finding.line ?? 0} ${finding.code}`)).toEqual([
      "rules/sales.yaml:2 integrity.rule_without_discovered_check",
      "rules/sales.yaml:2 integrity.rule_without_discovered_check",
      "src/a.test.ts:2 integrity.discovery_error",
      "src/sales.test.ts:10 integrity.check_without_registry_declaration",
      "src/sales.test.ts:10 integrity.unknown_flow",
      "src/sales.test.ts:10 integrity.unknown_rule_id",
    ]);
    // Same file, same line: the code orders the findings, the message breaks ties.
    expect(findings[0]?.message).toContain('"AAA-001"');
    expect(findings[1]?.message).toContain('"BBB-002"');
  });

  it("never throws on an empty registry or a registry with no flows", () => {
    expect(reconcile({ rules: [], flows: [], files: [] }, disc([]))).toEqual([]);
    expect(reconcile({ rules: [], flows: [], files: [] }, disc([{ checkId: "sales.a", rules: ["SALES-404"] }]))).toEqual([
      expect.objectContaining({ code: "integrity.check_without_registry_declaration" }),
      expect.objectContaining({ code: "integrity.unknown_rule_id" }),
    ]);
  });
});
