/**
 * Spec §8 stage 7 — roll facts up into verdicts.
 *
 * Input: the loaded registry, the discovered checks, the adapter's results and
 * the negative-control outcomes. Output: per-check, per-rule and per-flow
 * verdicts, each with a reason code. A pure function: no I/O, no clock, no
 * mutation of its inputs, and it never throws on an empty registry or discovery.
 *
 * The ordering is a total order (R41): `pass < not-run < flaky < blocked < fail`.
 * `not-run` already outranks `pass`, so a check that was skipped or absent from a
 * report can never launder a green gate.
 */
import type { CheckResult } from "../adapter/api.js";
import type { DiscoveredCheck, FlowRef } from "../discovery/types.js";
import type { CheckDecl, CheckLayer, Flow, FlowCheckDecl, FlowStep, Registry, Rule } from "../registry/model.js";
import { isProof } from "./proof.js";
import type {
  CheckVerdict,
  FlowVerdict,
  ReasonCode,
  RuleVerdict,
  SabotageOutcome,
  StepVerdict,
  Verdict,
} from "./types.js";

/** R41: the total order. Higher is worse; `worst` never lets a lower value hide one. */
const VERDICT_RANK: Record<Verdict, number> = {
  pass: 0,
  "not-run": 1,
  flaky: 2,
  blocked: 3,
  fail: 4,
};

/** R41: the worse of two verdicts; `worst` over no verdicts is `pass`. */
export function worst(a: Verdict, b: Verdict): Verdict {
  return rankOf(a) >= rankOf(b) ? a : b;
}

/** Roll a set of verdicts up to its worst member; an empty set is `pass`. */
function worstOf(verdicts: readonly Verdict[]): Verdict {
  let result: Verdict = "pass";
  for (const verdict of verdicts) result = worst(result, verdict);
  return result;
}

/**
 * Turn the registry, discovery, results and sabotage outcomes into verdicts.
 *
 * Attribution is by the check's own tags (R39): a check contributes to a rule
 * only when its `rules` array contains that rule's id. A declared check that was
 * never discovered contributes nothing (integrity already fails that repo); a
 * rule left with no attributed check is red with `rule_no_check`, never green by
 * default.
 */
export function computeVerdicts(input: {
  registry: Registry;
  discovered: DiscoveredCheck[];
  results: CheckResult[];
  outcomes: Map<string, SabotageOutcome>;
}): { checks: CheckVerdict[]; rules: RuleVerdict[]; flows: FlowVerdict[] } {
  const rules = listOf<Rule>(input?.registry?.rules);
  const flows = listOf<Flow>(input?.registry?.flows);
  const discovered = listOf<DiscoveredCheck>(input?.discovered);
  const results = listOf<CheckResult>(input?.results);
  const outcomes = input?.outcomes;

  const checks = buildCheckVerdicts(discovered, results, outcomes, declaredLayers(rules, flows));
  const ruleVerdicts = buildRuleVerdicts(rules, checks);

  return { checks, rules: ruleVerdicts, flows: buildFlowVerdicts(flows, checks, ruleVerdicts) };
}

/**
 * One verdict per discovered check, in discovery order (R40, R9).
 *
 * `runChecks` returns exactly one result per input check, in input order, so
 * equal lengths are zipped by index. Any other length means the list did not
 * come straight from that contract (a report, a partial run), and results are
 * matched by `runtimeId`, consuming each at most once. A check with no result is
 * `not-run`; a missing result is never treated as a pass.
 */
function buildCheckVerdicts(
  discovered: DiscoveredCheck[],
  results: CheckResult[],
  outcomes: Map<string, SabotageOutcome> | undefined,
  layers: Map<string, CheckLayer>,
): CheckVerdict[] {
  const paired = pairResults(discovered, results);

  return discovered.map((check, index) => {
    const checkId = text(check.checkId) ?? "";
    const result = paired[index];
    const verdict = verdictOf(result);
    const layer = layers.get(checkId);
    const message = typeof result?.message === "string" ? result.message : undefined;

    return {
      checkId,
      ruleIds: stringsOf(check.rules),
      flowRefs: listOf<FlowRef>(check.flows),
      ...(layer !== undefined ? { layer } : {}),
      file: text(check.file) ?? "",
      line: typeof check.line === "number" ? check.line : 0,
      runtimeId: text(check.runtimeId) ?? "",
      verdict,
      reason: checkReason(verdict),
      ...(message !== undefined ? { message } : {}),
      negativeControl: outcomes?.get(checkId) ?? { status: "not-executed" },
    };
  });
}

/** R40: index pairing only when the counts agree; otherwise first unused runtime id. */
function pairResults(discovered: DiscoveredCheck[], results: CheckResult[]): Array<CheckResult | undefined> {
  if (results.length === discovered.length) return discovered.map((_, index) => results[index]);

  const consumed = new Set<number>();
  return discovered.map((check) => {
    const runtimeId = text(check.runtimeId);
    if (runtimeId === undefined) return undefined;
    const index = results.findIndex(
      (result, candidate) => !consumed.has(candidate) && text(result.runtimeId) === runtimeId,
    );
    if (index === -1) return undefined;
    consumed.add(index);
    return results[index];
  });
}

/** R4: worst over the attributed checks; no attributed check is red, not green. */
function buildRuleVerdicts(rules: Rule[], checks: CheckVerdict[]): RuleVerdict[] {
  const checksByRule = new Map<string, CheckVerdict[]>();
  for (const check of checks) {
    // A duplicate `@rule` tag is an integrity finding; attribution itself is
    // still one edge, so the rule does not list the same check twice.
    for (const ruleId of new Set(check.ruleIds)) {
      const group = checksByRule.get(ruleId);
      if (group === undefined) checksByRule.set(ruleId, [check]);
      else group.push(check);
    }
  }

  return rules.map((rule) => {
    const ruleId = text(rule.id) ?? "";
    const attributed = checksByRule.get(ruleId) ?? [];
    const verdict = attributed.length === 0 ? "fail" : worstOf(attributed.map((check) => check.verdict));
    const worstCheck = attributed.find((check) => rankOf(check.verdict) === rankOf(verdict));

    return {
      ruleId,
      capability: capabilityOf(rule.source?.file),
      criticality: rule.criticality,
      status: rule.status,
      verdict,
      reason: attributed.length === 0 ? "rule_no_check" : (worstCheck?.reason ?? checkReason(verdict)),
      checkIds: attributed.map((check) => check.checkId),
      sabotageVerified: attributed.length > 0 && attributed.every((check) => isProof(check.negativeControl)),
    };
  });
}

/**
 * One verdict per flow, in registry order (R7). A flow is green only when every
 * governing rule, every step and every flow-level check is green; the worst
 * contributor decides the verdict. A step names its own status, and the flow's
 * reason points at either the offending flow-level check or the governing rule.
 */
function buildFlowVerdicts(flows: Flow[], checks: CheckVerdict[], rules: RuleVerdict[]): FlowVerdict[] {
  const ruleById = new Map(rules.map((rule) => [rule.ruleId, rule]));
  const checksById = new Map<string, CheckVerdict[]>();
  for (const check of checks) {
    const group = checksById.get(check.checkId);
    if (group === undefined) checksById.set(check.checkId, [check]);
    else group.push(check);
  }

  return flows.map((flow) => {
    const governingRules: RuleVerdict[] = [];
    const steps: StepVerdict[] = [];

    for (const step of listOf<FlowStep>(flow.steps)) {
      const ruleIds = stringsOf(step.rules);
      const ruled = ruleIds
        .map((ruleId) => ruleById.get(ruleId))
        .filter((rule): rule is RuleVerdict => rule !== undefined);
      governingRules.push(...ruled);

      const verdict = worstOf(ruled.map((rule) => rule.verdict));
      steps.push({
        stepId: text(step.id) ?? "",
        verdict,
        reason: verdict === "pass" ? "governing_rule_green" : "governing_rule_not_green",
        ruleIds,
      });
    }

    const checkIds = listOf<FlowCheckDecl>(flow.checks)
      .map((check) => text(check.id))
      .filter((checkId): checkId is string => checkId !== undefined);
    const flowChecks = checkIds.flatMap((checkId) => checksById.get(checkId) ?? []);

    const flowCheckWorst = worstOf(flowChecks.map((check) => check.verdict));
    const governingWorst = worstOf([
      ...governingRules.map((rule) => rule.verdict),
      ...steps.map((step) => step.verdict),
    ]);
    const verdict = worst(flowCheckWorst, governingWorst);

    return {
      flowId: text(flow.id) ?? "",
      criticality: flow.criticality,
      verdict,
      reason: flowReason(verdict, flowCheckWorst, governingWorst),
      checkIds,
      steps,
    };
  });
}

/**
 * R42: `flow_passed` when green; `flow_check_not_green` only when a flow-level
 * check is the flow's worst contributor (strictly worse than the governing
 * side); otherwise the red comes from a rule/step, so `governing_rule_not_green`.
 * On a tie the governing rule wins: the step is the more actionable detail, and
 * the flow-level check is still visible in `checks`.
 */
function flowReason(verdict: Verdict, flowCheckWorst: Verdict, governingWorst: Verdict): ReasonCode {
  if (verdict === "pass") return "flow_passed";
  return rankOf(flowCheckWorst) > rankOf(governingWorst) ? "flow_check_not_green" : "governing_rule_not_green";
}

/** The reason matching a check's verdict; `blocked` is reserved for later phases. */
function checkReason(verdict: Verdict): ReasonCode {
  switch (verdict) {
    case "pass":
      return "check.passed";
    case "fail":
      return "check.failed";
    case "not-run":
      return "check.not_run";
    case "flaky":
      return "check.flaky";
    case "blocked":
      return "check.blocked";
  }
}

/** A result's outcome, defensively normalised; anything unknown is not-run, never pass. */
function verdictOf(result: CheckResult | undefined): Verdict {
  const outcome = result?.outcome;
  return outcome === "pass" || outcome === "fail" || outcome === "not-run" || outcome === "flaky"
    ? outcome
    : "not-run";
}

/** R8: layer comes from the registry declaration, never from the test file. */
function declaredLayers(rules: Rule[], flows: Flow[]): Map<string, CheckLayer> {
  const layers = new Map<string, CheckLayer>();
  const declare = (check: CheckDecl | FlowCheckDecl): void => {
    const checkId = text(check.id);
    if (checkId !== undefined && !layers.has(checkId)) layers.set(checkId, check.layer);
  };

  for (const rule of rules) for (const check of listOf<CheckDecl>(rule.checks)) declare(check);
  for (const flow of flows) for (const check of listOf<FlowCheckDecl>(flow.checks)) declare(check);
  return layers;
}

/** R5: `rules/sales.yaml` → `sales`; the basename without its extension. */
function capabilityOf(file: string | undefined): string {
  const path = text(file) ?? "";
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.endsWith(".yaml") ? base.slice(0, -".yaml".length) : base;
}

function rankOf(verdict: Verdict): number {
  return VERDICT_RANK[verdict] ?? 0;
}

/** A defensive array view: a missing or non-array value is empty. */
function listOf<T>(value: readonly T[] | undefined | null): T[] {
  return Array.isArray(value) ? value.filter((entry: T) => typeof entry === "object" && entry !== null) : [];
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
