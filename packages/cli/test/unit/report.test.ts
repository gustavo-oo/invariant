import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExitCode } from "../../src/exit.js";
import { computeClass, type GuaranteeClass } from "../../src/guarantee/class.js";
import type {
  Report,
  ReportInput,
  WireCheckVerdict,
  WireFinding,
  WireRuleVerdict,
} from "../../src/report/shape.js";
import { renderComment } from "../../src/report/comment.js";
import { buildReport } from "../../src/report/write.js";
import type { Finding, Registry, Rule } from "../../src/registry/model.js";
import type { CheckVerdict, FlowVerdict, RuleVerdict, SabotageOutcome } from "../../src/verdict/types.js";
import { makeTmpRepo } from "../helpers/fixture.js";
import { normalizeReport } from "../helpers/goldens.js";

const OBSERVATION_REASON = "Branch-protection observation is unavailable, so the class cannot be G1.";
const CREDENTIAL_REASON = "No credential boundary is declared in .invariant/config.yaml, so the class cannot be G2.";

interface ReportOptions {
  /** The statement rendered in the rule cell (the escaping focus). */
  statement?: string;
  /** How many enforced rules the report carries; defaults to one, in a flow. */
  enforcedRules?: number;
  /** The rule's sabotage proof; `false` must read `checked`, `true` `proven`. */
  sabotageVerified?: boolean;
  /** Adds a second rule that no flow step names. */
  outsideRule?: string;
  class?: GuaranteeClass;
  negativeControl?: "declared-only" | "executed";
  /** The published exit code; `2` is the gate-broken case the comment must explain. */
  exitCode?: ExitCode;
  /** Integrity findings carried by the report. */
  integrity?: WireFinding[];
}

/**
 * A complete `Report`, not a partial cast: the comment renderer consumes the
 * whole wire shape, so a lens test must build the whole thing.
 */
function reportWith(options: ReportOptions = {}): Report {
  const cls = options.class ?? "G3";
  const statement = options.statement ?? "A sale MUST NOT complete when stock is insufficient.";
  const ruleCount = options.enforcedRules ?? 1;
  const verified = options.sabotageVerified ?? false;
  const control: SabotageOutcome = verified
    ? { status: "applied", classification: "assertion" }
    : { status: "not-executed" };

  const rules: WireRuleVerdict[] = Array.from({ length: ruleCount }, (_, index) => ({
    rule_id: ruleCount === 1 ? "SALES-004" : `SALES-00${index + 4}`,
    statement,
    capability: "sales",
    criticality: "normal",
    status: "enforced",
    verdict: "pass",
    reason: "check.passed",
    check_ids: [`sales.check-${index + 1}`],
    sabotage_verified: verified,
  }));
  const flowRuleIds = rules.map((rule) => rule.rule_id);

  const checks: WireCheckVerdict[] = rules.map((rule, index) => ({
    check_id: rule.check_ids[0] ?? "",
    rule_ids: [rule.rule_id],
    flow_refs: [{ flow: "checkout", step: "s1" }],
    layer: "integration",
    file: "src/sales.test.ts",
    line: 4,
    runtime_id: `checkout > sale check ${index + 1}`,
    verdict: "pass",
    reason: "check.passed",
    negative_control: control,
  }));

  const flowChecks: WireCheckVerdict[] = [
    {
      check_id: "checkout.completes",
      rule_ids: [],
      flow_refs: [{ flow: "checkout" }],
      layer: "e2e",
      file: "src/checkout.test.ts",
      line: 4,
      runtime_id: "checkout > completes",
      verdict: "pass",
      reason: "check.passed",
      negative_control: { status: "not-executed" },
    },
  ];

  if (options.outsideRule !== undefined) {
    const ruleId = options.outsideRule;
    rules.push({
      rule_id: ruleId,
      statement: "A return MUST be accepted within 30 days.",
      capability: "returns",
      criticality: "normal",
      status: "enforced",
      verdict: "pass",
      reason: "check.passed",
      check_ids: ["returns.accepts"],
      sabotage_verified: false,
    });
    checks.push({
      check_id: "returns.accepts",
      rule_ids: [ruleId],
      flow_refs: [],
      layer: "unit",
      file: "src/returns.test.ts",
      line: 4,
      runtime_id: "returns > accepts",
      verdict: "pass",
      reason: "check.passed",
      negative_control: { status: "not-executed" },
    });
  }

  return {
    schema_version: 1,
    tool: { name: "invariant", version: "0.1.0" },
    inputs: { mode: "local", base: null, head: null, repo: null, run_id: null },
    guarantee: {
      class: cls,
      class_reasons:
        cls === "G1" ? [] : cls === "G2" ? [OBSERVATION_REASON] : [OBSERVATION_REASON, CREDENTIAL_REASON],
      binding: cls === "G1" || cls === "G2",
      negative_control: options.negativeControl ?? "declared-only",
      doctor:
        cls === "G1"
          ? { ran: true, class: "G1", reasons: [], findings: [], observation: "available" }
          : { ran: false, class: "G3", reasons: [], findings: [], observation: "unavailable" },
    },
    registry: {
      files: ["rules/sales.yaml"],
      hashes: { "rules/sales.yaml": `sha256:${"0".repeat(64)}` },
    },
    immutability: { protected_paths_changed: [], flagged: false },
    integrity: options.integrity ?? [],
    checks: [...checks, ...flowChecks],
    rules,
    flows: [
      {
        flow_id: "checkout",
        criticality: "normal",
        verdict: "pass",
        reason: "flow_passed",
        check_ids: ["checkout.completes"],
        steps: [{ step_id: "s1", verdict: "pass", reason: "governing_rule_green", rule_ids: flowRuleIds }],
      },
    ],
    exit_code: options.exitCode ?? 1,
  };
}

describe("renderComment (spec §8 stage 8)", () => {
  it("escapes Markdown-hostile text in rule statements (review focus 2)", () => {
    const md = renderComment(reportWith({ statement: "A sale | MUST NOT complete\nwhen `stock` < 1 * 2" }));
    expect(md).not.toMatch(/A sale \|/);
    expect(md).toContain("A sale \\| MUST NOT complete when \\`stock\\` < 1 \\* 2");
    expect(md.split("\n").every((line) => !line.includes("\n"))).toBe(true);
  });

  it("renders a hostile statement as one exactly escaped row", () => {
    // Pipe, backtick, star, backslash and CRLF all in one business statement.
    const statement = "A sale \\| MUST NOT complete\r\nwhen `stock` < 1 * 2 and \\` \\* \\\\";
    const md = renderComment(reportWith({ statement }));
    expect(md.split("\n")).toContain(
      "| checkout | pass | s1 | SALES-004 — A sale \\\\\\| MUST NOT complete when \\`stock\\` < 1 \\* 2 and \\\\\\` \\\\\\* \\\\\\\\ (checked) | pass | sales.check-1 | check.passed |",
    );
  });

  it("collapses CRLF and every newline to a single space", () => {
    const md = renderComment(reportWith({ statement: "first\r\nsecond\nthird" }));
    expect(md).toContain("first second third");
    expect(md).not.toContain("\r");
  });

  it("states the guarantee class and the declared-only negative control", () => {
    const md = renderComment(reportWith({}));
    expect(md).toContain("## invariant — G3 (procedural)");
    expect(md).toContain("Seam sabotage is NOT executed in this delivery");
    expect(md).toContain("| Flow | Verdict | Step | Rule | Verdict | Check | Reason |");
  });

  it("names the mechanism in the heading and warns below G1 only", () => {
    const g1 = renderComment(reportWith({ class: "G1" }));
    expect(g1).toContain("## invariant — G1 (observed)");
    expect(g1).not.toContain("**No guarantee is claimed by this run.**");

    const g2 = renderComment(reportWith({ class: "G2" }));
    expect(g2).toContain("## invariant — G2 (declared)");
    expect(g2).toContain("**No guarantee is claimed by this run.**");

    const g3 = renderComment(reportWith({ class: "G3" }));
    expect(g3).toContain("## invariant — G3 (procedural)");
    expect(g3).toContain("**No guarantee is claimed by this run.**");
  });

  it("says exactly 'no enforced rules' instead of claiming a vacuous green (review focus 5)", () => {
    const md = renderComment(reportWith({ enforcedRules: 0 }));
    const lines = md.split("\n");
    expect(lines).toContain("No enforced rules are declared");
    expect(lines.filter((line) => line === "No enforced rules are declared")).toHaveLength(1);
  });

  it("says checked until sabotage is verified, and proven only then", () => {
    const checked = renderComment(reportWith({ sabotageVerified: false }));
    expect(checked).toContain("(checked)");
    expect(checked).not.toContain("(proven)");

    const proven = renderComment(reportWith({ sabotageVerified: true }));
    expect(proven).toContain("(proven)");
    expect(proven).not.toContain("(checked)");
  });

  it("renders flow-level checks with empty step and rule cells", () => {
    const md = renderComment(reportWith({}));
    expect(md).toContain("| checkout | pass |  |  | pass | checkout.completes | check.passed |");
  });

  it("keeps the required blocks in the brief's order", () => {
    const md = renderComment(reportWith({ outsideRule: "SALES-900" }));
    const positions = [
      "## invariant — G3 (procedural)",
      "**Guarantee class: G3 (procedural).**",
      "Seam sabotage is NOT executed",
      "**No guarantee is claimed by this run.**",
      "| Flow | Verdict | Step | Rule | Verdict | Check | Reason |",
      "### Rules outside any flow",
    ].map((needle) => md.indexOf(needle));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // The below-G1 warning occupies a line of its own (ruling 6).
    expect(md.split("\n")).toContain("**No guarantee is claimed by this run.**");
  });

  it("renders a per-rule list for rules in no flow", () => {
    const md = renderComment(reportWith({ outsideRule: "SALES-900" }));
    expect(md).toContain("| checkout | pass | s1 |");
    expect(md).toContain("### Rules outside any flow");

    const outside = md.slice(md.indexOf("### Rules outside any flow"));
    expect(outside).toContain("SALES-900");
    expect(outside).not.toContain("SALES-004");
  });

  it("renders a Gate failures section for a red gate, after the warning and before the table (R51)", () => {
    const md = renderComment(
      reportWith({
        exitCode: 2,
        enforcedRules: 0,
        integrity: [
          {
            code: "upstream.job_cancelled",
            message: "invariant-registry was cancelled",
            file: "invariant-registry/registry-result.json",
          },
          {
            code: "upstream.artifact_missing",
            message: "artifact | not `found`",
            file: "invariant-checks/checks-result.json",
          },
        ],
      }),
    );

    const lines = md.split("\n");
    expect(lines).toContain("### Gate failures");
    expect(lines).toContain("- upstream.job_cancelled — invariant-registry was cancelled");
    // Cells go through the existing escaping, so a hostile message cannot break
    // the list or open a code span.
    expect(lines).toContain("- upstream.artifact_missing — artifact \\| not \\`found\\`");

    const warning = md.indexOf("**No guarantee is claimed by this run.**");
    const noRules = md.indexOf("No enforced rules are declared");
    const section = md.indexOf("### Gate failures");
    const table = md.indexOf("| Flow | Verdict | Step | Rule | Verdict | Check | Reason |");
    expect(warning).toBeGreaterThanOrEqual(0);
    expect(noRules).toBeGreaterThan(warning);
    expect(section).toBeGreaterThan(noRules);
    expect(table).toBeGreaterThan(section);
  });

  it("omits the Gate failures section when the gate did not fail", () => {
    for (const exitCode of [0, 1] as const) {
      const md = renderComment(
        reportWith({
          exitCode,
          integrity: [{ code: "upstream.job_cancelled", message: "cancelled", file: "f" }],
        }),
      );
      expect(md).not.toContain("### Gate failures");
    }
  });
});

describe("computeClass (spec §9.1)", () => {
  it("never reaches G1 without an observation or with any protection finding", () => {
    expect(computeClass({ observationAvailable: false, protectionFindings: [], credentialBoundary: false }).class).toBe("G3");
    expect(computeClass({ observationAvailable: false, protectionFindings: [], credentialBoundary: true }).class).toBe("G2");
    expect(
      computeClass({
        observationAvailable: true,
        protectionFindings: [{ code: "check.not_pinned_to_app", message: "x" }],
        credentialBoundary: false,
      }).class,
    ).toBe("G3");
    expect(computeClass({ observationAvailable: true, protectionFindings: [], credentialBoundary: false }).class).toBe("G1");
  });

  it("is binding for G1 and G2 and never for G3", () => {
    expect(computeClass({ observationAvailable: true, protectionFindings: [], credentialBoundary: false }).binding).toBe(true);
    expect(computeClass({ observationAvailable: false, protectionFindings: [], credentialBoundary: true }).binding).toBe(true);
    expect(computeClass({ observationAvailable: false, protectionFindings: [], credentialBoundary: false }).binding).toBe(false);
  });

  it("explains every input that lowered the class, in the fixed order", () => {
    const lowered = computeClass({
      observationAvailable: false,
      protectionFindings: [
        { code: "check.not_pinned_to_app", message: "x" },
        { code: "protection.none", message: "y" },
      ],
      credentialBoundary: false,
    });
    expect(lowered.reasons).toHaveLength(3);
    expect(lowered.reasons[0]).toContain("observation");
    expect(lowered.reasons[1]).toContain("check.not_pinned_to_app");
    expect(lowered.reasons[1]).toContain("protection.none");
    expect(lowered.reasons[2]).toContain("credential boundary");

    expect(computeClass({ observationAvailable: true, protectionFindings: [], credentialBoundary: false }).reasons).toEqual([]);
  });
});

function ruleModel(id: string): Rule {
  return {
    id,
    statement: `Statement for ${id}.`,
    rationale: "Because.",
    criticality: "normal",
    status: "enforced",
    checks: [{ id: `${id}.check`, layer: "integration" }],
    source: { file: "rules/sales.yaml", line: 2 },
  };
}

async function wireInput(): Promise<ReportInput> {
  const root = await makeTmpRepo({
    "rules/sales.yaml": "rules: []\n",
    "rules/returns.yaml": "rules: []\n",
  });

  const registry: Registry = {
    rules: [ruleModel("RET-001"), ruleModel("SALES-004")],
    flows: [],
    // Deliberately unsorted: the report must canonicalise the file list.
    files: ["rules/sales.yaml", "rules/returns.yaml"],
  };

  const checks: CheckVerdict[] = [
    {
      checkId: "sales.z",
      ruleIds: ["SALES-004", "ANOTHER"],
      flowRefs: [
        { flow: "returns", step: "s2" },
        { flow: "checkout", step: "s1" },
      ],
      layer: "integration",
      file: "src/sales.test.ts",
      line: 4,
      runtimeId: "checkout > z",
      verdict: "pass",
      reason: "check.passed",
      message: "z passed",
      negativeControl: { status: "applied", classification: "assertion" },
    },
    {
      checkId: "sales.a",
      ruleIds: [],
      flowRefs: [],
      file: "src/sales.test.ts",
      line: 9,
      runtimeId: "checkout > a",
      verdict: "fail",
      reason: "check.failed",
      negativeControl: { status: "not-executed" },
    },
  ];

  const rules: RuleVerdict[] = [
    {
      ruleId: "RET-001",
      capability: "returns",
      criticality: "normal",
      status: "enforced",
      verdict: "pass",
      reason: "check.passed",
      checkIds: ["returns.z", "returns.a"],
      sabotageVerified: false,
    },
    {
      ruleId: "SALES-004",
      capability: "sales",
      criticality: "critical",
      status: "enforced",
      verdict: "pass",
      reason: "check.passed",
      checkIds: ["sales.z", "sales.a"],
      sabotageVerified: true,
    },
  ];

  const flows: FlowVerdict[] = [
    {
      flowId: "returns",
      criticality: "normal",
      verdict: "pass",
      reason: "flow_passed",
      checkIds: ["returns.done"],
      steps: [],
    },
    {
      flowId: "checkout",
      criticality: "critical",
      verdict: "fail",
      reason: "governing_rule_not_green",
      checkIds: ["checkout.z", "checkout.a"],
      steps: [{ stepId: "s2", verdict: "pass", reason: "governing_rule_green", ruleIds: ["RET-001", "SALES-004"] }],
    },
  ];

  const integrity: Finding[] = [
    {
      code: "immutability.protected_path_changed",
      message: "rules changed",
      file: "rules/sales.yaml",
      line: 3,
      ruleId: "SALES-004",
      flowId: "checkout",
      checkId: "sales.z",
    },
  ];

  return {
    root,
    toolVersion: "9.9.9",
    inputs: { mode: "pr", base: "b1", head: "h1", repo: "acme/shop", runId: "42" },
    registry,
    verdicts: { checks, rules, flows },
    integrity,
    guarantee: {
      class: "G3",
      classReasons: [OBSERVATION_REASON, CREDENTIAL_REASON],
      binding: false,
      negativeControl: "declared-only",
      doctor: { ran: false, class: "G3", reasons: [], findings: [], observation: "unavailable" },
    },
    immutability: { protectedPathsChanged: ["rules/sales.yaml", ".github/CODEOWNERS"], flagged: true },
    exitCode: 1,
  };
}

describe("buildReport (wire shape)", () => {
  it("maps every camelCase field to its snake_case wire key", async () => {
    const report = buildReport(await wireInput());

    expect(Object.keys(report)).toEqual([
      "schema_version",
      "tool",
      "inputs",
      "guarantee",
      "registry",
      "immutability",
      "integrity",
      "checks",
      "rules",
      "flows",
      "exit_code",
    ]);
    expect(report).not.toHaveProperty("timestamp");
    expect(report).not.toHaveProperty("duration");

    expect(report.tool).toEqual({ name: "invariant", version: "9.9.9" });
    expect(report.inputs).toEqual({ mode: "pr", base: "b1", head: "h1", repo: "acme/shop", run_id: "42" });
    expect(report.guarantee).toMatchObject({
      class: "G3",
      class_reasons: [OBSERVATION_REASON, CREDENTIAL_REASON],
      binding: false,
      negative_control: "declared-only",
    });
    expect(report.exit_code).toBe(1);
    expect(report.immutability).toEqual({
      protected_paths_changed: [".github/CODEOWNERS", "rules/sales.yaml"],
      flagged: true,
    });

    const sales = report.rules.find((rule) => rule.rule_id === "SALES-004");
    expect(sales).toBeDefined();
    expect(sales?.check_ids).toEqual(["sales.a", "sales.z"]);
    expect(sales?.sabotage_verified).toBe(true);
    expect(sales?.statement).toBe("Statement for SALES-004.");
    expect(sales).not.toHaveProperty("ruleId");
    expect(sales).not.toHaveProperty("checkIds");
    expect(sales).not.toHaveProperty("sabotageVerified");

    const z = report.checks.find((check) => check.check_id === "sales.z");
    expect(z?.rule_ids).toEqual(["ANOTHER", "SALES-004"]);
    expect(z?.flow_refs).toEqual([
      { flow: "checkout", step: "s1" },
      { flow: "returns", step: "s2" },
    ]);
    expect(z?.negative_control).toEqual({ status: "applied", classification: "assertion" });
    expect(z?.runtime_id).toBe("checkout > z");
    expect(z).not.toHaveProperty("ruleIds");
    expect(z).not.toHaveProperty("flowRefs");
    expect(z).not.toHaveProperty("negativeControl");
    expect(z).not.toHaveProperty("runtimeId");

    const noLayer = report.checks.find((check) => check.check_id === "sales.a");
    expect(noLayer).not.toHaveProperty("layer");
    expect(noLayer).not.toHaveProperty("message");

    const finding = report.integrity[0];
    expect(finding).toMatchObject({
      code: "immutability.protected_path_changed",
      file: "rules/sales.yaml",
      line: 3,
      rule_id: "SALES-004",
      flow_id: "checkout",
      check_id: "sales.z",
    });
    expect(finding).not.toHaveProperty("ruleId");
    expect(finding).not.toHaveProperty("flowId");
    expect(finding).not.toHaveProperty("checkId");
  });

  it("sorts every id-bearing array and the registry file list", async () => {
    const report = buildReport(await wireInput());

    expect(report.registry.files).toEqual(["rules/returns.yaml", "rules/sales.yaml"]);
    expect(Object.keys(report.registry.hashes)).toEqual(report.registry.files);
    expect(report.checks.map((check) => check.check_id)).toEqual(["sales.a", "sales.z"]);
    expect(report.rules.map((rule) => rule.rule_id)).toEqual(["RET-001", "SALES-004"]);
    expect(report.flows.map((flow) => flow.flow_id)).toEqual(["checkout", "returns"]);
    expect(report.flows[0]?.check_ids).toEqual(["checkout.a", "checkout.z"]);
    expect(report.flows[0]?.steps[0]?.rule_ids).toEqual(["RET-001", "SALES-004"]);
  });

  it("hashes each registry file with sha256, in sorted file order, stable by content", async () => {
    const input = await wireInput();
    const report = buildReport(input);

    const salesBytes = await readFile(path.join(input.root, "rules/sales.yaml"));
    const returnsBytes = await readFile(path.join(input.root, "rules/returns.yaml"));
    const salesHash = `sha256:${createHash("sha256").update(salesBytes).digest("hex")}`;

    expect(report.registry.hashes["rules/sales.yaml"]).toBe(salesHash);
    expect(report.registry.hashes["rules/sales.yaml"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Identical content hashes identically.
    expect(report.registry.hashes["rules/returns.yaml"]).toBe(salesHash);
    expect(returnsBytes.equals(salesBytes)).toBe(true);
    // Rebuilding over the same tree is byte-identical.
    expect(buildReport(input).registry.hashes).toEqual(report.registry.hashes);
  });

  it("refuses a G1 report without observed doctor evidence (R48)", async () => {
    const input = await wireInput();
    const g1 = {
      ...input,
      guarantee: { ...input.guarantee, class: "G1" as const, binding: true, classReasons: [] },
    };

    const notRun = {
      ...g1,
      guarantee: {
        ...g1.guarantee,
        doctor: { ran: false, class: "G1" as const, reasons: [], findings: [], observation: "available" as const },
      },
    };
    expect(() => buildReport(notRun)).toThrow(/doctor\.ran=false/);
    expect(() => buildReport(notRun)).toThrow(/observation=available/);

    const notObserved = {
      ...g1,
      guarantee: {
        ...g1.guarantee,
        doctor: { ran: true, class: "G1" as const, reasons: [], findings: [], observation: "unavailable" as const },
      },
    };
    expect(() => buildReport(notObserved)).toThrow(/doctor\.ran=true/);
    expect(() => buildReport(notObserved)).toThrow(/observation=unavailable/);
  });

  it("builds a consistent G1 report and keeps the comment free of the warning", async () => {
    const input = await wireInput();
    const report = buildReport({
      ...input,
      guarantee: {
        ...input.guarantee,
        class: "G1",
        binding: true,
        classReasons: [],
        doctor: { ran: true, class: "G1", reasons: [], findings: [], observation: "available" },
      },
    });

    expect(report.guarantee.class).toBe("G1");
    expect(report.guarantee.binding).toBe(true);
    expect(report.guarantee.doctor).toEqual({
      ran: true,
      class: "G1",
      reasons: [],
      findings: [],
      observation: "available",
    });
    expect(renderComment(report)).not.toContain("**No guarantee is claimed by this run.**");
  });
});

describe("normalizeReport (test helper)", () => {
  it("returns a typed report with the tool version normalised", () => {
    const report = normalizeReport(reportWith({}));
    expect(report.tool.version).toBe("<version>");
    expect(report.schema_version).toBe(1);
    expect(report.rules[0]?.rule_id).toBe("SALES-004");
  });

  it("rejects a value that is not a report-shaped object", () => {
    expect(() => normalizeReport(null)).toThrow();
    expect(() => normalizeReport({})).toThrow();
    expect(() => normalizeReport({ schema_version: 1, tool: { name: "invariant", version: "0.1.0" } })).toThrow();
  });
});
