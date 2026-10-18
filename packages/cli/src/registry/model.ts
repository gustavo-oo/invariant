/**
 * The in-memory shape of the registry (`rules/**`), the single source of truth
 * (design spec §5). This module declares the types once; every other module
 * imports them from here.
 *
 * The loader (`load.ts`) constructs these objects from YAML. It is a boundary:
 * a document that violates the JSON Schema is still converted, so the §5
 * validator (`validate.ts`, a later task) can report the semantic problem
 * instead of the loader silently dropping the rule. That is why `kind` is a
 * plain `string` here even though the schema pins it to `"seam"` — the
 * validator owns `registry.negative_control_kind_unsupported`.
 */

/** Rule criticality (spec §5.1): `critical | normal`. */
export type Criticality = "critical" | "normal";

/** Rule lifecycle (spec §5.3): `draft | enforced | deprecated`. */
export type RuleStatus = "draft" | "enforced" | "deprecated";

/** Where a check runs (spec §5.1): `unit | integration | e2e`. */
export type CheckLayer = "unit" | "integration" | "e2e";

/** Repo-relative file plus the 1-based line of a node's first key. */
export interface SourceRef {
  file: string;
  line: number;
}

/**
 * The negative control a check must declare (spec §5.1). The only kind that
 * exists is `seam`; there is no counter-example alternative and no escape hatch.
 * `sabotage` is a repo-relative path under `.invariant/sabotages/`.
 */
export interface NegativeControl {
  kind: string;
  seam: string;
  sabotage: string;
}

/** A check declared by a rule (spec §5.1). */
export interface CheckDecl {
  id: string;
  layer: CheckLayer;
  negativeControl?: NegativeControl;
}

/** A rule (spec §5.1). */
export interface Rule {
  id: string;
  statement: string;
  rationale: string;
  criticality: Criticality;
  status: RuleStatus;
  checks: CheckDecl[];
  owners?: string[];
  paths?: string[];
  replacedBy?: string;
  retired?: boolean;
  source: SourceRef;
}

/** One step of a flow (spec §5.2). */
export interface FlowStep {
  id: string;
  name: string;
  rules: string[];
}

/** A flow-level end-to-end check (spec §5.2). Flow checks carry no negative control. */
export interface FlowCheckDecl {
  id: string;
  layer: CheckLayer;
}

/** A flow (spec §5.2). */
export interface Flow {
  id: string;
  name: string;
  owner: string;
  criticality: Criticality;
  steps: FlowStep[];
  checks: FlowCheckDecl[];
  paths?: string[];
  source: SourceRef;
}

/** The whole registry, plus the repo-relative files it was read from. */
export interface Registry {
  rules: Rule[];
  flows: Flow[];
  /** Sorted, repo-relative paths of every registry file actually read. */
  files: string[];
}

/**
 * A single problem found while loading or validating the registry or the
 * configuration. Declared once here and re-exported by `registry/load.ts` and
 * `registry/validate.ts`.
 */
export interface Finding {
  code: string;
  message: string;
  file: string;
  line?: number;
  ruleId?: string;
  flowId?: string;
  checkId?: string;
}
