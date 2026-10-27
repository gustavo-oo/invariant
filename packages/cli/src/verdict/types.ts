/**
 * Verdicts: the shape of the roll-up (spec §8 stage 7). The pipeline's earlier
 * stages produce facts — a loaded registry, discovered checks, raw results and
 * sabotage outcomes. This module fixes how those facts are reported as verdicts;
 * `compute.ts` is the only place that decides them.
 */
import type { FlowRef } from "../discovery/types.js";
import type { CheckLayer, Criticality, RuleStatus } from "../registry/model.js";

/** The five states a check, rule, step or flow can be in. Ranked in `compute.ts`. */
export type Verdict = "pass" | "fail" | "not-run" | "flaky" | "blocked";

/**
 * Why a verdict has the value it does (R42). Checks carry `check.*`; a rule
 * repeats its worst check's reason or `rule_no_check`; steps and flows say
 * whether the governing rule or the flow-level check is responsible.
 */
export type ReasonCode =
  | "check.passed"
  | "check.failed"
  | "check.not_run"
  | "check.flaky"
  | "check.blocked"
  | "rule_no_check"
  | "governing_rule_not_green"
  | "governing_rule_green"
  | "flow_check_not_green"
  | "flow_passed";

/**
 * The negative-control decision table's input (spec §7, SELF-004). An outcome is
 * proof only when the sabotage was actually applied and the failure it produced
 * was classified as an assertion; a harness error or a timeout proves nothing.
 */
export type SabotageOutcome =
  | { status: "not-executed" }
  | { status: "not-applied" }
  | { status: "applied"; classification: "assertion" | "harness" | "timeout" };

/** One discovered check's verdict, with the identity needed to explain it. */
export interface CheckVerdict {
  checkId: string;
  /** The rules the check's own `@rule` tags name (R39). */
  ruleIds: string[];
  /** The flow steps the check's `@flow` tags name. */
  flowRefs: FlowRef[];
  /** From the registry declaration; absent when no rule or flow declares the id. */
  layer?: CheckLayer;
  file: string;
  line: number;
  runtimeId: string;
  verdict: Verdict;
  reason: ReasonCode;
  message?: string;
  negativeControl: SabotageOutcome;
}

/** A rule's verdict, computed from the checks tagged with its id. */
export interface RuleVerdict {
  ruleId: string;
  /** `rules/sales.yaml` → `sales` (the capability document's basename). */
  capability: string;
  criticality: Criticality;
  status: RuleStatus;
  verdict: Verdict;
  reason: ReasonCode;
  /** Attributed checks, in discovery order. */
  checkIds: string[];
  /** True only when every attributed check is proof of an assertion failure. */
  sabotageVerified: boolean;
}

/** One flow step's verdict: worst over the rules the step governs. */
export interface StepVerdict {
  stepId: string;
  verdict: Verdict;
  reason: ReasonCode;
  ruleIds: string[];
}

/** A flow's verdict: worst over its governing rules, flow checks and steps. */
export interface FlowVerdict {
  flowId: string;
  criticality: Criticality;
  verdict: Verdict;
  reason: ReasonCode;
  /** The flow's declared flow-level check ids, in declaration order. */
  checkIds: string[];
  /** Steps in declaration order. */
  steps: StepVerdict[];
}
