/**
 * Spec §5 validation: the cross-cutting rules the JSON Schema cannot express
 * (id shape, uniqueness, the enforced⇒seam contract, deprecated replacement and
 * the flow rules). A pure function over a loaded registry: findings only, no
 * I/O, no test execution, no verdicts.
 *
 * The loader keeps schema-invalid nodes (best effort), so every property read
 * here is treated as `unknown` at runtime even where the model declares it
 * required: reporting a malformed document is this module's job, never crashing
 * on it.
 */
import path from "node:path";
import type { Config } from "../config/model.js";
import type { Finding, Registry, SourceRef } from "./model.js";

export type { Finding } from "./model.js";

/** The arguments `validateRegistry` will grow to need (sabotage resolution, protected paths). */
export interface ValidateOptions {
  cwd: string;
  config: Config;
}

/** Spec §5.1: `^[A-Z][A-Z0-9]*-\d{3}$`. */
const RULE_ID = /^[A-Z][A-Z0-9]*-\d{3}$/;

/** The one directory a sabotage path may live under. */
const SABOTAGE_PREFIX = ".invariant/sabotages/";

/**
 * Validate a loaded registry against spec §5 and return every finding, in the
 * code order the spec lists them. An empty array means the registry is valid —
 * including a registry with zero enforced rules (review focus 5).
 */
export function validateRegistry(registry: Registry, _opts: ValidateOptions): Finding[] {
  const findings: Finding[] = [];
  const ruleIds = new Set<string>();
  const seenRuleIds = new Set<string>();
  const seenCheckIds = new Set<string>();
  const seenFlowIds = new Set<string>();

  for (const rule of registry.rules) {
    if (typeof rule.id === "string") ruleIds.add(rule.id);
  }

  for (const rule of registry.rules) {
    const source = rule.source;
    const ruleId = typeof rule.id === "string" ? rule.id : undefined;
    const ids: Identifiers = { ruleId };

    if (ruleId === undefined || !RULE_ID.test(ruleId)) {
      findings.push(issue("registry.invalid_id", `rule id ${describe(rule.id)} must match ${RULE_ID.source}`, source, ids));
    }
    if (ruleId !== undefined) {
      if (seenRuleIds.has(ruleId)) {
        findings.push(issue("registry.duplicate_rule_id", `duplicate rule id ${describe(ruleId)}`, source, ids));
      } else {
        seenRuleIds.add(ruleId);
      }
    }

    if (typeof rule.statement !== "string" || rule.statement.trim() === "") {
      findings.push(issue("registry.missing_statement", "rule statement must be non-empty", source, ids));
    }
    if (typeof rule.rationale !== "string" || rule.rationale.trim() === "") {
      findings.push(issue("registry.missing_rationale", "rule rationale must be non-empty", source, ids));
    }

    const checks = Array.isArray(rule.checks) ? rule.checks : [];
    for (const check of checks) {
      const checkId = typeof check.id === "string" ? check.id : undefined;
      if (checkId === undefined) continue;
      if (seenCheckIds.has(checkId)) {
        findings.push(issue("registry.duplicate_check_id", `duplicate check id ${describe(checkId)}`, source, { ruleId, checkId }));
      } else {
        seenCheckIds.add(checkId);
      }
    }

    if (rule.status === "enforced") {
      if (checks.length === 0) {
        findings.push(issue("registry.enforced_without_check", `enforced rule ${label(ruleId)} has no checks`, source, ids));
      }
      if (!Array.isArray(rule.owners) || rule.owners.length === 0) {
        findings.push(issue("registry.enforced_without_owners", `enforced rule ${label(ruleId)} has no owners`, source, ids));
      }
      for (const check of checks) {
        const checkId = typeof check.id === "string" ? check.id : undefined;
        const negativeControl = check.negativeControl;
        if (negativeControl === undefined) {
          findings.push(
            issue(
              "registry.enforced_without_negative_control",
              `check ${label(checkId)} has no negative_control (enforced rules need a seam sabotage on every check)`,
              source,
              { ruleId, checkId },
            ),
          );
        } else if (typeof negativeControl.seam !== "string" || negativeControl.seam.trim() === "") {
          findings.push(
            issue(
              "registry.enforced_without_negative_control",
              `check ${label(checkId)} declares a negative_control without a non-empty seam`,
              source,
              { ruleId, checkId },
            ),
          );
        }
      }
    }

    for (const check of checks) {
      const checkId = typeof check.id === "string" ? check.id : undefined;
      const negativeControl = check.negativeControl;
      if (negativeControl === undefined) continue;
      if (negativeControl.kind !== "seam") {
        findings.push(
          issue(
            "registry.negative_control_kind_unsupported",
            `negative_control.kind ${describe(negativeControl.kind)} is not supported; the only kind is "seam"`,
            source,
            { ruleId, checkId },
          ),
        );
      }
      if (!isSabotagePath(negativeControl.sabotage)) {
        findings.push(
          issue(
            "registry.sabotage_path_invalid",
            `sabotage path ${describe(negativeControl.sabotage)} must be a repo-relative path under ${SABOTAGE_PREFIX}`,
            source,
            { ruleId, checkId },
          ),
        );
      }
    }

    if (rule.status === "deprecated") {
      const replacement = typeof rule.replacedBy === "string" ? rule.replacedBy : undefined;
      const replacedByExisting = replacement !== undefined && ruleIds.has(replacement);
      if (rule.retired !== true && !replacedByExisting) {
        findings.push(
          issue(
            "registry.deprecated_without_replacement",
            `deprecated rule ${label(ruleId)} needs replaced_by naming an existing rule or retired: true`,
            source,
            ids,
          ),
        );
      }
    }
  }

  for (const flow of registry.flows) {
    const source = flow.source;
    const flowId = typeof flow.id === "string" ? flow.id : undefined;
    const ids: Identifiers = { flowId };

    if (flowId !== undefined) {
      if (seenFlowIds.has(flowId)) {
        findings.push(issue("flow.duplicate_flow_id", `duplicate flow id ${describe(flowId)}`, source, ids));
      } else {
        seenFlowIds.add(flowId);
      }
    }

    const checks = Array.isArray(flow.checks) ? flow.checks : [];
    for (const check of checks) {
      const checkId = typeof check.id === "string" ? check.id : undefined;
      if (checkId === undefined) continue;
      if (seenCheckIds.has(checkId)) {
        findings.push(issue("registry.duplicate_check_id", `duplicate check id ${describe(checkId)}`, source, { flowId, checkId }));
      } else {
        seenCheckIds.add(checkId);
      }
    }

    const steps = Array.isArray(flow.steps) ? flow.steps : [];
    for (const step of steps) {
      const stepRules = Array.isArray(step.rules) ? step.rules : [];
      for (const referenced of stepRules) {
        if (typeof referenced !== "string" || !ruleIds.has(referenced)) {
          findings.push(
            issue(
              "flow.unknown_rule",
              `step ${describe(step.id)} references unknown rule ${describe(referenced)}`,
              source,
              ids,
            ),
          );
        }
      }
    }

    for (const step of steps) {
      const stepRules = Array.isArray(step.rules) ? step.rules : [];
      if (stepRules.length === 0) {
        findings.push(issue("flow.step_without_rules", `step ${describe(step.id)} must reference at least one rule`, source, ids));
      }
    }

    const seenStepIds = new Set<string>();
    for (const step of steps) {
      if (typeof step.id !== "string") continue;
      if (seenStepIds.has(step.id)) {
        findings.push(
          issue("flow.duplicate_step_id", `duplicate step id ${describe(step.id)} in flow ${label(flowId)}`, source, ids),
        );
      } else {
        seenStepIds.add(step.id);
      }
    }

    const hasE2e = checks.some((check) => check.layer === "e2e");
    if (flow.criticality === "critical" && !hasE2e) {
      findings.push(
        issue("flow.critical_without_e2e", `critical flow ${label(flowId)} needs at least one e2e check`, source, ids),
      );
    }
  }

  return findings;
}

/**
 * A sabotage path is valid only when it is a string that, once normalized,
 * still lives under `.invariant/sabotages/`. The schema's pattern accepts
 * `../` segments (they are in its character class), so escape attempts are the
 * validator's responsibility: reject absolute paths and any path that climbs
 * out of the directory.
 */
function isSabotagePath(value: unknown): boolean {
  if (typeof value !== "string" || value === "") return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (path.posix.isAbsolute(normalized)) return false;
  if (normalized === ".." || normalized.startsWith("../")) return false;
  return normalized.startsWith(SABOTAGE_PREFIX) && normalized.length > SABOTAGE_PREFIX.length;
}

function issue(
  code: string,
  message: string,
  source: SourceRef,
  ids: Identifiers,
): Finding {
  const finding: Finding = { code, message, file: source.file };
  if (typeof source.line === "number") finding.line = source.line;
  if (ids.ruleId !== undefined) finding.ruleId = ids.ruleId;
  if (ids.flowId !== undefined) finding.flowId = ids.flowId;
  if (ids.checkId !== undefined) finding.checkId = ids.checkId;
  return finding;
}

interface Identifiers {
  ruleId?: string | undefined;
  flowId?: string | undefined;
  checkId?: string | undefined;
}

function label(value: string | undefined): string {
  return value === undefined ? "(missing)" : describe(value);
}

function describe(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
