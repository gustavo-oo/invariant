/**
 * Spec §8 stage 3 — integrity reconciliation.
 *
 * The registry and the discovered tests are two halves of one mapping, and both
 * directions must agree: a rule whose declared check no test implements, and a
 * tagged test that points at something the registry never declared, are both
 * gate errors (exit 2, no verdicts). Orphans are integrity findings, not
 * verdicts (spec §3).
 *
 * A pure function over a loaded registry and a `DiscoveryResult`: no I/O, no
 * execution, and it never throws on a malformed document — every property is
 * re-checked at runtime even where the model declares it required. Matching is
 * exact and case-sensitive throughout: a case-insensitive match would turn a
 * typo like `@rule sales-004` into a green gate.
 */
import type { DiscoveredCheck, DiscoveryError, DiscoveryResult, FlowRef } from "../discovery/types.js";
import type { CheckDecl, Finding, Flow, FlowStep, Registry, Rule } from "./model.js";

/** Used only when a malformed document gives no repo-relative path at all. */
const UNKNOWN_FILE = "(unknown file)";

/** A repo-relative location; `line` is absent when the document carried none. */
interface Location {
  file: string;
  line?: number | undefined;
}

/** The identifiers a finding may name, all optional. */
interface Identifiers {
  ruleId?: string | undefined;
  flowId?: string | undefined;
  checkId?: string | undefined;
}

/**
 * Reconcile the registry against discovery and return every finding, sorted by
 * `file`, `line ?? 0`, `code`, then `message` so goldens and `--json` output are
 * stable.
 *
 * Codes reported here:
 * - `integrity.rule_without_discovered_check` — an `enforced` rule, or a `draft`
 *   rule that declares at least one check, with none of its declared checks
 *   discovered. A draft rule that declares no check is legal.
 * - `integrity.check_without_registry_declaration` — a discovered `@check` that
 *   no rule and no flow declares.
 * - `integrity.unknown_rule_id` — a `@rule` naming no registry rule, including a
 *   case mismatch.
 * - `integrity.duplicate_check_tag` — the same `@check` on two distinct tests, or
 *   the same `@rule` twice in one test's tags. Two tests carrying the same
 *   `@rule` is legal: that is how a rule gets several checks.
 * - `integrity.negative_control_mismatch` — a `@negative-control` tag that is not
 *   the registry's declared sabotage path (PEND-4). No tag is legal: the
 *   registry's path is authoritative.
 * - `integrity.unknown_flow` / `integrity.unknown_step` / `integrity.rule_not_in_step`
 *   — a `@flow` tag naming a flow, step or step rule the registry does not carry.
 * - `integrity.discovery_error` — a discovery error passed through unchanged,
 *   plus a duplicate `runtimeId`, which makes result attribution ambiguous.
 */
export function reconcile(registry: Registry, discovery: DiscoveryResult): Finding[] {
  const findings: Finding[] = [];
  const rules = listOf<Rule>(registry.rules);
  const flows = listOf<Flow>(registry.flows);
  const discovered = listOf<DiscoveredCheck>(discovery.checks);

  const ruleById = new Map<string, Rule>();
  const flowById = new Map<string, Flow>();
  /**
   * Every check id the registry declares, mapped to its declared sabotage path.
   * `undefined` means the declaration carries no negative control (a flow-level
   * check never does). Presence in the map is what makes the declaration real.
   */
  const declaredChecks = new Map<string, string | undefined>();

  for (const rule of rules) {
    const ruleId = text(rule.id);
    if (ruleId !== undefined && !ruleById.has(ruleId)) ruleById.set(ruleId, rule);
    for (const check of listOf<CheckDecl>(rule.checks)) {
      const checkId = text(check.id);
      if (checkId === undefined || declaredChecks.has(checkId)) continue;
      declaredChecks.set(checkId, sabotageOf(check));
    }
  }
  for (const flow of flows) {
    const flowId = text(flow.id);
    if (flowId !== undefined && !flowById.has(flowId)) flowById.set(flowId, flow);
    for (const check of listOf<CheckDecl>(flow.checks)) {
      const checkId = text(check.id);
      if (checkId === undefined || declaredChecks.has(checkId)) continue;
      declaredChecks.set(checkId, undefined);
    }
  }

  const discoveredCheckIds = new Set<string>();
  for (const check of discovered) {
    const checkId = text(check.checkId);
    if (checkId !== undefined) discoveredCheckIds.add(checkId);
  }

  // Direction one: a rule whose declared check no test implements.
  for (const rule of rules) {
    const status = rule.status;
    if (status !== "enforced" && status !== "draft") continue;
    const declarations = listOf<CheckDecl>(rule.checks);
    const declaredIds: string[] = [];
    for (const check of declarations) {
      const checkId = text(check.id);
      if (checkId !== undefined) declaredIds.push(checkId);
    }
    // Review ruling R34: a draft rule with zero declared checks declares
    // knowledge without a seam and is not an orphan.
    if (status === "draft" && declarations.length === 0) continue;
    if (declaredIds.some((checkId) => discoveredCheckIds.has(checkId))) continue;

    const ruleId = text(rule.id);
    const detail =
      declaredIds.length === 0 ? "it declares no check id" : `missing ${declaredIds.map(quote).join(", ")}`;
    findings.push(
      finding({
        code: "integrity.rule_without_discovered_check",
        message: `${status} rule ${label(ruleId)} has no discovered check (${detail})`,
        at: sourceOf(rule),
        ids: { ruleId },
      }),
    );
  }

  // Direction two: every discovered tag must resolve against the registry.
  for (const check of discovered) {
    const at = testSource(check);
    const checkId = text(check.checkId);
    const checkLabel = label(checkId);
    const taggedRules = stringsOf(check.rules);
    const ids: Identifiers = { checkId };

    if (checkId !== undefined && !declaredChecks.has(checkId)) {
      findings.push(
        finding({
          code: "integrity.check_without_registry_declaration",
          message: `check ${checkLabel} is not declared by any rule or flow`,
          at,
          ids,
        }),
      );
    }

    // R33: a repeated @rule within one test's tags is ambiguous; the same rule
    // on two different tests is the normal "several checks per rule" case.
    for (const [ruleId, count] of counts(taggedRules)) {
      if (count < 2) continue;
      findings.push(
        finding({
          code: "integrity.duplicate_check_tag",
          message: `@rule ${quote(ruleId)} appears ${count} times on one test (check ${checkLabel})`,
          at,
          ids: { ...ids, ruleId },
        }),
      );
    }

    for (const ruleId of new Set(taggedRules)) {
      if (ruleById.has(ruleId)) continue;
      findings.push(
        finding({
          code: "integrity.unknown_rule_id",
          message: `@rule ${quote(ruleId)} on check ${checkLabel} does not name a registry rule`,
          at,
          ids: { ...ids, ruleId },
        }),
      );
    }

    const taggedControl = check.negativeControl;
    if (checkId !== undefined && typeof taggedControl === "string" && declaredChecks.has(checkId)) {
      const declared = declaredChecks.get(checkId);
      if (declared === undefined) {
        findings.push(
          finding({
            code: "integrity.negative_control_mismatch",
            message: `@negative-control ${quote(taggedControl)} on check ${checkLabel} has no registry declaration (the check declares no negative_control)`,
            at,
            ids,
          }),
        );
      } else if (declared !== taggedControl) {
        findings.push(
          finding({
            code: "integrity.negative_control_mismatch",
            message: `@negative-control ${quote(taggedControl)} on check ${checkLabel} does not match the registry's sabotage path ${quote(declared)}`,
            at,
            ids,
          }),
        );
      }
    }

    for (const ref of listOf<FlowRef>(check.flows)) {
      const flowId = text(ref.flow);
      if (flowId === undefined) continue;
      const flow = flowById.get(flowId);
      if (flow === undefined) {
        findings.push(
          finding({
            code: "integrity.unknown_flow",
            message: `@flow ${quote(flowId)} on check ${checkLabel} does not name a registry flow`,
            at,
            ids: { ...ids, flowId },
          }),
        );
        continue;
      }

      const stepId = text(ref.step);
      if (stepId === undefined) continue;
      const tag = `${flowId}/${stepId}`;
      const step = listOf<FlowStep>(flow.steps).find((candidate) => text(candidate.id) === stepId);
      if (step === undefined) {
        findings.push(
          finding({
            code: "integrity.unknown_step",
            message: `@flow ${quote(tag)} on check ${checkLabel}: flow ${quote(flowId)} has no step ${quote(stepId)}`,
            at,
            ids: { ...ids, flowId },
          }),
        );
        continue;
      }

      const stepRules = new Set(stringsOf(step.rules));
      for (const ruleId of new Set(taggedRules)) {
        // A rule already reported as unknown cannot be in any step; one finding
        // for the real defect is better than two.
        if (!ruleById.has(ruleId)) continue;
        if (stepRules.has(ruleId)) continue;
        findings.push(
          finding({
            code: "integrity.rule_not_in_step",
            message: `@flow ${quote(tag)} on check ${checkLabel}: step ${quote(stepId)} does not list tagged rule ${quote(ruleId)}`,
            at,
            ids: { ...ids, flowId, ruleId },
          }),
        );
      }
    }
  }

  findings.push(...duplicateCheckTags(discovered));
  findings.push(...duplicateRuntimeIds(discovered));
  findings.push(...discoveryErrors(discovery.errors));

  return findings.sort(compareFindings);
}

/** One finding per `@check` id found on more than one distinct test. */
function duplicateCheckTags(discovered: DiscoveredCheck[]): Finding[] {
  const findings: Finding[] = [];
  const byCheckId = new Map<string, DiscoveredCheck[]>();

  for (const check of discovered) {
    const checkId = text(check.checkId);
    if (checkId === undefined) continue;
    const group = byCheckId.get(checkId);
    if (group === undefined) byCheckId.set(checkId, [check]);
    else group.push(check);
  }

  for (const [checkId, group] of byCheckId) {
    const distinct = distinctTests(group);
    const [first, ...duplicates] = distinct;
    if (first === undefined || duplicates.length === 0) continue;
    const firstAt = locationText(first);
    for (const duplicate of duplicates) {
      findings.push(
        finding({
          code: "integrity.duplicate_check_tag",
          message: `duplicate @check ${quote(checkId)} (already declared at ${firstAt})`,
          at: testSource(duplicate),
          ids: { checkId },
        }),
      );
    }
  }

  return findings;
}

/**
 * R35: `CheckResult` carries no check id or file, so two discovered checks with
 * the same `runtimeId` make result attribution ambiguous. That is an integrity
 * failure, reported with the existing discovery-error pass-through code.
 */
function duplicateRuntimeIds(discovered: DiscoveredCheck[]): Finding[] {
  const findings: Finding[] = [];
  const byRuntimeId = new Map<string, DiscoveredCheck[]>();

  for (const check of discovered) {
    const runtimeId = text(check.runtimeId);
    if (runtimeId === undefined) continue;
    const group = byRuntimeId.get(runtimeId);
    if (group === undefined) byRuntimeId.set(runtimeId, [check]);
    else group.push(check);
  }

  for (const [runtimeId, group] of byRuntimeId) {
    if (group.length < 2) continue;
    const ordered = [...group].sort(compareTests);
    const [first, second] = ordered;
    if (first === undefined || second === undefined) continue;
    const checkIds: string[] = [];
    for (const check of ordered) {
      const checkId = text(check.checkId);
      if (checkId !== undefined && !checkIds.includes(checkId)) checkIds.push(checkId);
    }
    const named = checkIds.length === 0 ? "(unnamed)" : checkIds.map(quote).join(", ");
    findings.push(
      finding({
        code: "integrity.discovery_error",
        message: `duplicate runtime id ${quote(runtimeId)} is shared by checks ${named} (first at ${locationText(first)})`,
        at: testSource(second),
      }),
    );
  }

  return findings;
}

/** Every recovered discovery problem is a gate finding: the mapping cannot be trusted. */
function discoveryErrors(errors: DiscoveryError[] | undefined): Finding[] {
  return listOf<DiscoveryError>(errors).map((error) => {
    const message = typeof error.message === "string" ? error.message : String(error.message);
    return finding({
      code: "integrity.discovery_error",
      message,
      at: { file: text(error.file) ?? UNKNOWN_FILE, line: typeof error.line === "number" ? error.line : undefined },
    });
  });
}

function finding(input: { code: string; message: string; at: Location; ids?: Identifiers }): Finding {
  const result: Finding = { code: input.code, message: input.message, file: input.at.file };
  if (input.at.line !== undefined) result.line = input.at.line;
  const ids = input.ids;
  if (ids?.ruleId !== undefined) result.ruleId = ids.ruleId;
  if (ids?.flowId !== undefined) result.flowId = ids.flowId;
  if (ids?.checkId !== undefined) result.checkId = ids.checkId;
  return result;
}

/** file, then line, then code, then message: the golden/`--json` order. */
function compareFindings(left: Finding, right: Finding): number {
  return (
    compareText(left.file, right.file) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    compareText(left.code, right.code) ||
    compareText(left.message, right.message)
  );
}

/** Two tests are distinct when they sit at different file/line locations. */
function distinctTests(checks: DiscoveredCheck[]): DiscoveredCheck[] {
  const seen = new Set<string>();
  const unique: DiscoveredCheck[] = [];
  for (const check of checks) {
    const key = locationText(check);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(check);
  }
  return unique.sort(compareTests);
}

function compareTests(left: DiscoveredCheck, right: DiscoveredCheck): number {
  return (
    compareText(testSource(left).file, testSource(right).file) ||
    (testSource(left).line ?? 0) - (testSource(right).line ?? 0) ||
    compareText(text(left.runtimeId) ?? "", text(right.runtimeId) ?? "")
  );
}

function locationText(check: DiscoveredCheck): string {
  const at = testSource(check);
  return at.line === undefined ? at.file : `${at.file}:${at.line}`;
}

function testSource(check: DiscoveredCheck): Location {
  return { file: text(check.file) ?? UNKNOWN_FILE, line: typeof check.line === "number" ? check.line : undefined };
}

function sourceOf(rule: Rule): Location {
  const source = rule.source;
  return {
    file: text(source?.file) ?? UNKNOWN_FILE,
    line: typeof source?.line === "number" ? source.line : undefined,
  };
}

function sabotageOf(check: CheckDecl): string | undefined {
  const sabotage = check.negativeControl?.sabotage;
  return typeof sabotage === "string" ? sabotage : undefined;
}

function counts(values: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function listOf<T>(value: readonly T[] | undefined | null): T[] {
  return Array.isArray(value) ? [...value] : [];
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function label(value: string | undefined): string {
  return value === undefined ? "(missing)" : quote(value);
}

function quote(value: string): string {
  return JSON.stringify(value);
}
