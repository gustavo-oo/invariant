import { describe, expect, it } from "vitest";
import type { DiscoveredCheck, DiscoveryError, DiscoveryResult } from "../../src/discovery/types.js";
import { reconcile } from "../../src/registry/integrity.js";
import type { CheckDecl, Flow, Registry, Rule, RuleStatus } from "../../src/registry/model.js";

interface FlowSpec {
  flow: string;
  /** Step id -> the rules the step lists. */
  steps: Record<string, string[]>;
  /** Flow-level check ids the flow declares. */
  checks?: string[];
}

interface RegistryOptions {
  status?: RuleStatus;
  /** Sabotage path given to every declared check. */
  sabotage?: string;
}

/** An in-memory registry: rule id -> declared check ids, plus an optional flow. */
function reg(rules: Record<string, string[]>, flow?: FlowSpec, options: RegistryOptions = {}): Registry {
  const status = options.status ?? "enforced";
  const built: Rule[] = [];

  for (const [ruleId, checkIds] of Object.entries(rules)) {
    // A test helper that silently drops a malformed map makes `toEqual([])`
    // pass vacuously, so an unexpected shape is a hard error.
    if (!Array.isArray(checkIds) || checkIds.some((checkId) => typeof checkId !== "string")) {
      throw new Error(`reg: ${ruleId} must map to a string[] of check ids`);
    }
    built.push(buildRule(ruleId, checkIds, options.sabotage, status));
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
        reg({ "SALES-004": ["sales.a"] }, undefined, { sabotage: ".invariant/sabotages/sales/one.ts" }),
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
        reg({ "SALES-004": ["sales.a"] }, undefined, { sabotage: ".invariant/sabotages/sales/one.ts" }),
        disc([{ checkId: "sales.a", rules: ["SALES-004"], negativeControl: ".invariant/sabotages/sales/one.ts" }]),
      ),
    ).toEqual([]);
  });

  it("is silent when no @negative-control tag is present (the registry path is authoritative)", () => {
    expect(
      codes(
        reg({ "SALES-004": ["sales.a"] }, undefined, { sabotage: ".invariant/sabotages/sales/one.ts" }),
        disc([{ checkId: "sales.a", rules: ["SALES-004"] }]),
      ),
    ).toEqual([]);
  });

  it("says the registry declares no negative_control when a flow-level check is tagged", () => {
    const registry = reg(
      { "SALES-009": [] },
      { flow: "checkout", steps: { s1: ["SALES-009"] }, checks: ["checkout.completes"] },
      { status: "draft" },
    );
    const findings = reconcile(
      registry,
      disc([
        {
          checkId: "checkout.completes",
          flows: [{ flow: "checkout" }],
          negativeControl: ".invariant/sabotages/sales/one.ts",
        },
      ]),
    );
    expect(findings.map((finding) => finding.code)).toEqual(["integrity.negative_control_mismatch"]);
    expect(findings[0]?.message).toContain("the registry declares no negative_control for this check");
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
    // Same file: result attribution by (file, runtimeId) is genuinely ambiguous.
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

  it("treats the same runtime id in two different files as two different checks", () => {
    // runtimeId has no file component, but the execution layer keys results by
    // (file, runtimeId): the same title in another file is not ambiguous.
    expect(
      codes(
        reg({ "SALES-004": ["sales.a", "sales.b"] }),
        disc([
          { checkId: "sales.a", rules: ["SALES-004"], file: "src/a.test.ts", runtimeId: "sales > works" },
          { checkId: "sales.b", rules: ["SALES-004"], file: "src/b.test.ts", runtimeId: "sales > works" },
        ]),
      ),
    ).toEqual([]);
  });

  it("does not let a check tagged with another rule satisfy the declaring rule (R39)", () => {
    const findings = reconcile(
      reg({ "SALES-004": ["sales.a"] }),
      disc([{ checkId: "sales.a", rules: ["SALES-005"] }]),
    );
    expect(findings.map((finding) => finding.code)).toEqual([
      "integrity.rule_without_discovered_check",
      "integrity.unknown_rule_id",
    ]);
    expect(findings[0]?.ruleId).toBe("SALES-004");
  });

  it("flags a rule when only some of its declared checks are discovered (R38)", () => {
    const [finding] = reconcile(
      reg({ "SALES-004": ["sales.a", "sales.b"] }),
      disc([{ checkId: "sales.a", rules: ["SALES-004"] }]),
    );
    expect(finding?.code).toBe("integrity.rule_without_discovered_check");
    expect(finding?.ruleId).toBe("SALES-004");
    expect(finding?.message).toContain("is missing a discovered check");
    expect(finding?.message).toContain('"sales.b"');
    expect(finding?.message).not.toContain('"sales.a"');
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

  it("never throws on malformed input: null entries, null documents and an empty registry", () => {
    expect(reconcile({ rules: [], flows: [], files: [] }, disc([]))).toEqual([]);
    expect(reconcile({ rules: [], flows: [], files: [] }, disc([{ checkId: "sales.a", rules: ["SALES-404"] }]))).toEqual([
      expect.objectContaining({ code: "integrity.check_without_registry_declaration" }),
      expect.objectContaining({ code: "integrity.unknown_rule_id" }),
    ]);

    // A null entry in either discovery list must be skipped, not dereferenced.
    const malformed = {
      checks: [
        null,
        {
          checkId: "sales.a",
          rules: ["SALES-004"],
          flows: [],
          testName: "test",
          file: "src/sales.test.ts",
          line: 3,
          frameworkId: "vitest",
          runtimeId: "suite > test",
        },
      ],
      errors: [null, { file: "src/broken.test.ts", message: "broken" }],
    } as unknown as DiscoveryResult;
    expect(reconcile(reg({ "SALES-004": ["sales.a"] }), malformed).map((finding) => finding.code)).toEqual([
      "integrity.discovery_error",
    ]);

    // A null document (not just a malformed property) must not throw either.
    expect(reconcile(null as unknown as Registry, null as unknown as DiscoveryResult)).toEqual([]);
  });
});
