/**
 * `write.ts` assembles `invariant-report.json` from facts the pipeline already
 * decided. It maps camelCase in-memory verdicts to the snake_case wire shape,
 * hashes the registry files and sorts every id-bearing array. It performs no
 * discovery, no execution and no verdict computation of its own.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Finding } from "../registry/model.js";
import type { CheckVerdict, FlowVerdict, RuleVerdict, SabotageOutcome, StepVerdict } from "../verdict/types.js";
import type {
  DoctorSummary,
  Report,
  ReportInput,
  WireCheckVerdict,
  WireFinding,
  WireFlowVerdict,
  WireRuleVerdict,
  WireStepVerdict,
} from "./shape.js";

/** Build the report; the only I/O is reading the registry files it hashes. */
export function buildReport(input: ReportInput): Report {
  assertG1Evidence(input.guarantee);
  const files = sortedStrings(input.registry.files);
  const statements = new Map(input.registry.rules.map((rule) => [rule.id, rule.statement]));

  return {
    schema_version: 1,
    tool: { name: "invariant", version: input.toolVersion },
    inputs: {
      mode: input.inputs.mode,
      base: input.inputs.base,
      head: input.inputs.head,
      repo: input.inputs.repo,
      run_id: input.inputs.runId,
    },
    guarantee: {
      class: input.guarantee.class,
      class_reasons: [...input.guarantee.classReasons],
      binding: input.guarantee.binding,
      negative_control: input.guarantee.negativeControl,
      doctor: copyDoctor(input.guarantee.doctor),
    },
    registry: { files, hashes: hashFiles(input.root, files) },
    immutability: {
      protected_paths_changed: sortedStrings(input.immutability.protectedPathsChanged),
      flagged: input.immutability.flagged,
    },
    integrity: sortFindings(input.integrity.map(wireFinding)),
    checks: sortBy(input.verdicts.checks.map(wireCheck), (check) => check.check_id),
    rules: sortBy(
      input.verdicts.rules.map((rule) => wireRule(rule, statements)),
      (rule) => rule.rule_id,
    ),
    flows: sortBy(input.verdicts.flows.map(wireFlow), (flow) => flow.flow_id),
    exit_code: input.exitCode,
  };
}

/** `sha256:<hex>` per file, keyed in sorted file order. */
function hashFiles(root: string, files: string[]): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const file of files) {
    const bytes = readFileSync(path.join(root, file));
    hashes[file] = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  }
  return hashes;
}

/**
 * R48: a G1 claim is only valid when the doctor actually observed protection.
 * Refuse to publish rather than downgrade silently: a caller that supplies the
 * class and the doctor result inconsistently has a bug, and hiding it would
 * let the one class the product exists to guarantee be claimed without
 * evidence.
 */
function assertG1Evidence(guarantee: ReportInput["guarantee"]): void {
  const { class: cls, doctor } = guarantee;
  if (cls !== "G1" || (doctor.ran && doctor.observation === "available")) return;
  throw new Error(
    `invariant: refusing to claim G1 without observed doctor evidence (doctor.ran=${doctor.ran}, observation=${doctor.observation})`,
  );
}

function wireCheck(check: CheckVerdict): WireCheckVerdict {
  return {
    check_id: check.checkId,
    rule_ids: sortedStrings(check.ruleIds),
    flow_refs: sortFlowRefs(check.flowRefs),
    ...(check.layer !== undefined ? { layer: check.layer } : {}),
    file: check.file,
    line: check.line,
    runtime_id: check.runtimeId,
    verdict: check.verdict,
    reason: check.reason,
    ...(check.message !== undefined ? { message: check.message } : {}),
    negative_control: copyOutcome(check.negativeControl),
  };
}

function wireRule(rule: RuleVerdict, statements: Map<string, string>): WireRuleVerdict {
  return {
    rule_id: rule.ruleId,
    statement: statements.get(rule.ruleId) ?? "",
    capability: rule.capability,
    criticality: rule.criticality,
    status: rule.status,
    verdict: rule.verdict,
    reason: rule.reason,
    check_ids: sortedStrings(rule.checkIds),
    sabotage_verified: rule.sabotageVerified,
  };
}

function wireFlow(flow: FlowVerdict): WireFlowVerdict {
  return {
    flow_id: flow.flowId,
    criticality: flow.criticality,
    verdict: flow.verdict,
    reason: flow.reason,
    check_ids: sortedStrings(flow.checkIds),
    steps: sortBy(flow.steps.map(wireStep), (step) => step.step_id),
  };
}

function wireStep(step: StepVerdict): WireStepVerdict {
  return {
    step_id: step.stepId,
    verdict: step.verdict,
    reason: step.reason,
    rule_ids: sortedStrings(step.ruleIds),
  };
}

function wireFinding(finding: Finding): WireFinding {
  return {
    code: finding.code,
    message: finding.message,
    file: finding.file,
    ...(finding.line !== undefined ? { line: finding.line } : {}),
    ...(finding.ruleId !== undefined ? { rule_id: finding.ruleId } : {}),
    ...(finding.flowId !== undefined ? { flow_id: finding.flowId } : {}),
    ...(finding.checkId !== undefined ? { check_id: finding.checkId } : {}),
  };
}

function copyDoctor(doctor: DoctorSummary): DoctorSummary {
  return {
    ran: doctor.ran,
    class: doctor.class,
    reasons: [...doctor.reasons],
    findings: doctor.findings.map((finding) => ({ code: finding.code, message: finding.message })),
    observation: doctor.observation,
  };
}

function copyOutcome(outcome: SabotageOutcome): SabotageOutcome {
  return outcome.status === "applied"
    ? { status: "applied", classification: outcome.classification }
    : { status: outcome.status };
}

function sortFlowRefs(refs: CheckVerdict["flowRefs"]): CheckVerdict["flowRefs"] {
  return [...refs]
    .map((ref) => (ref.step === undefined ? { flow: ref.flow } : { flow: ref.flow, step: ref.step }))
    .sort((a, b) => compare(a.flow, b.flow) || compare(a.step ?? "", b.step ?? ""));
}

function sortFindings(findings: WireFinding[]): WireFinding[] {
  return [...findings].sort(
    (a, b) =>
      compare(a.file, b.file) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      compare(a.code, b.code) ||
      compare(a.message, b.message),
  );
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort(compare);
}

function sortBy<T>(items: readonly T[], id: (item: T) => string): T[] {
  return [...items].sort((a, b) => compare(id(a), id(b)));
}

/** Locale-independent ordering: goldens must be byte-stable on every host. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
