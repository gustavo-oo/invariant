/**
 * The report's wire shape (`invariant-report.json`), fixed once for every
 * consumer: the CLI's writer, the golden files, and the `verdict`/`verify`
 * commands. Keys are snake_case throughout and the report carries no clock:
 * every volatile fact arrives as an explicit `inputs` field, so two runs over
 * the same tree produce byte-identical reports.
 */
import type { ExitCode } from "../exit.js";
import type { ClassFinding, GuaranteeClass } from "../guarantee/class.js";
import type { FlowRef } from "../discovery/types.js";
import type { CheckLayer, Criticality, Finding, Registry, RuleStatus } from "../registry/model.js";
import type {
  CheckVerdict,
  FlowVerdict,
  ReasonCode,
  RuleVerdict,
  SabotageOutcome,
  Verdict,
} from "../verdict/types.js";

/** The CI event that produced this run; `local` when there is none. */
export type ReportMode = "local" | "pr" | "push" | "merge_group";

/** The observed negative-control mechanism: Phase 1 can only declare it. */
export type NegativeControlMode = "declared-only" | "executed";

/**
 * What the doctor observed, as recorded in the report. When it did not run,
 * `ran` is false, `observation` is `unavailable` and `class` never rises above
 * what `computeClass` allows without an observation (spec §9.1).
 */
export interface DoctorSummary {
  ran: boolean;
  class: GuaranteeClass;
  reasons: string[];
  findings: ClassFinding[];
  observation: "available" | "unavailable";
}

/**
 * A registry or pipeline finding on the wire. Same keys as the in-memory
 * `Finding`, with the optional entity ids in snake_case.
 */
export interface WireFinding {
  code: string;
  message: string;
  file: string;
  line?: number;
  rule_id?: string;
  flow_id?: string;
  check_id?: string;
}

export interface WireStepVerdict {
  step_id: string;
  verdict: Verdict;
  reason: ReasonCode;
  rule_ids: string[];
}

export interface WireFlowVerdict {
  flow_id: string;
  criticality: Criticality;
  verdict: Verdict;
  reason: ReasonCode;
  check_ids: string[];
  steps: WireStepVerdict[];
}

/**
 * A rule verdict on the wire. `statement` is carried beyond `RuleVerdict` so
 * the PR comment can explain a rule to a human without reading the registry: it
 * is the only input `renderComment` has, and its escaping is review focus 2.
 */
export interface WireRuleVerdict {
  rule_id: string;
  statement: string;
  capability: string;
  criticality: Criticality;
  status: RuleStatus;
  verdict: Verdict;
  reason: ReasonCode;
  check_ids: string[];
  sabotage_verified: boolean;
}

export interface WireCheckVerdict {
  check_id: string;
  rule_ids: string[];
  flow_refs: FlowRef[];
  layer?: CheckLayer;
  file: string;
  line: number;
  runtime_id: string;
  verdict: Verdict;
  reason: ReasonCode;
  message?: string;
  negative_control: SabotageOutcome;
}

/** The five explicit inputs; there is no clock and no environment sniffing here. */
export interface ReportInputs {
  mode: ReportMode;
  base: string | null;
  head: string | null;
  repo: string | null;
  runId: string | null;
}

/** Protected-path changes recorded by stage 4, independent of the exit code. */
export interface ReportImmutability {
  protectedPathsChanged: string[];
  flagged: boolean;
}

/** The guarantee facts the caller computed; `buildReport` only maps them. */
export interface ReportGuaranteeInput {
  class: GuaranteeClass;
  classReasons: string[];
  binding: boolean;
  negativeControl: NegativeControlMode;
  doctor: DoctorSummary;
}

export interface Report {
  schema_version: 1;
  tool: { name: "invariant"; version: string };
  inputs: {
    mode: ReportMode;
    base: string | null;
    head: string | null;
    repo: string | null;
    run_id: string | null;
  };
  guarantee: {
    class: GuaranteeClass;
    class_reasons: string[];
    binding: boolean;
    negative_control: NegativeControlMode;
    doctor: DoctorSummary;
  };
  registry: {
    files: string[];
    hashes: Record<string, string>;
  };
  immutability: {
    protected_paths_changed: string[];
    flagged: boolean;
  };
  integrity: WireFinding[];
  checks: WireCheckVerdict[];
  rules: WireRuleVerdict[];
  flows: WireFlowVerdict[];
  exit_code: ExitCode;
}

/**
 * Everything `buildReport` needs, and nothing it has to discover or execute.
 * `root` is required because the registry hashes are read from the files
 * `registry.files` names.
 */
export interface ReportInput {
  root: string;
  toolVersion: string;
  inputs: ReportInputs;
  registry: Registry;
  verdicts: {
    checks: CheckVerdict[];
    rules: RuleVerdict[];
    flows: FlowVerdict[];
  };
  integrity: Finding[];
  guarantee: ReportGuaranteeInput;
  immutability: ReportImmutability;
  exitCode: ExitCode;
}
