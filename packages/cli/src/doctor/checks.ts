/**
 * Spec §9.3 items 1–7: what the environment actually protects, and the class it
 * supports.
 *
 * The class is not decided here. It comes from the one `computeClass` function
 * (Task 10) over the `severity: "fail"` findings, so `doctor`, `verify` and
 * `verdict` cannot disagree about G1. Offline checks (CODEOWNERS, workflow job
 * names/triggers) run even when the forge observation is unavailable: an
 * offline defect must not disappear just because the token is missing.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Config } from "../config/model.js";
import { classRank, computeClass, type GuaranteeClass } from "../guarantee/class.js";
import { reasonFor } from "../guarantee/reasons.js";
import type { DoctorObservation } from "../seams/forge-probe.js";
import type { Baseline } from "./baseline.js";
import { coversPaths, parseCodeowners, sizeOk } from "./codeowners.js";

export interface DoctorFinding {
  code: string;
  severity: "fail" | "info";
  message: string;
}

export interface DoctorCheckInput {
  observation: DoctorObservation;
  config: Config;
  baseline: Baseline;
  root: string;
  workflowText: string;
  workflowFiles: string[];
}

export interface DoctorCheckResult {
  findings: DoctorFinding[];
  class: GuaranteeClass;
  reasons: string[];
}

export function runDoctorChecks(input: DoctorCheckInput): DoctorCheckResult {
  const findings: DoctorFinding[] = [];
  const { observation, baseline, root } = input;

  if (!observation.available) {
    findings.push({
      code: "protection.unavailable",
      severity: "info",
      message: observation.reason,
    });
  } else {
    const protection = observation.protection;
    if (protection.mechanism === "none") {
      findings.push({
        code: "protection.none",
        severity: "fail",
        message: "No branch protection or ruleset covers the default branch.",
      });
    } else {
      const required = protection.requiredContexts.find(
        (context) => context.context === baseline.expected.required_context,
      );
      if (required === undefined) {
        findings.push({
          code: "protection.no_required_check",
          severity: "fail",
          message: `${baseline.expected.required_context} is not a required status check on the default branch.`,
        });
      } else if (required.appId !== baseline.expected.required_context_app_id) {
        findings.push({
          code: "check.not_pinned_to_app",
          severity: "fail",
          message: `${baseline.expected.required_context} is pinned to app ${required.appId ?? "null"}, expected ${baseline.expected.required_context_app_id}.`,
        });
      }

      if (!protection.codeOwnerReview) {
        findings.push({
          code: "codeowners.review_not_required",
          severity: "fail",
          message: "Branch protection does not require review from code owners.",
        });
      }

      if (protection.bypassActors.length > 0) {
        const extra = protection.bypassActors.filter(
          (actor) =>
            !baseline.expected.bypass_actors.some(
              (recorded) =>
                recorded.type === actor.type &&
                recorded.id === actor.id &&
                recorded.mode === actor.mode,
            ),
        );
        if (extra.length > 0) {
          findings.push({
            code: "bypass.grew",
            severity: "fail",
            message: `The bypass list gained: ${extra.map(formatBypass).join(", ")}.`,
          });
        } else {
          findings.push({
            code: "bypass.present",
            severity: "fail",
            message: `The bypass list is not empty: ${protection.bypassActors.map(formatBypass).join(", ")}.`,
          });
        }
      }

      if (protection.mergeQueue === "enabled" && !hasMergeGroup(input.workflowText)) {
        findings.push({
          code: "merge_queue.workflow_missing_trigger",
          severity: "fail",
          message: "A merge queue is enabled, but the workflow has no merge_group trigger.",
        });
      }
    }
  }

  findings.push(...codeownersFindings(root, baseline));
  findings.push(...ambiguousWorkflowFindings(input));

  const classResult = computeClass({
    observationAvailable: observation.available,
    protectionFindings: findings
      .filter((finding) => finding.severity === "fail")
      .map(({ code, message }) => ({ code, message })),
    credentialBoundary: input.config.credentialBoundary === "declared",
  });

  if (classRank(classResult.class) < classRank(baseline.recorded_class)) {
    findings.push({
      code: "baseline.regressed",
      severity: "fail",
      message: `Observed class ${classResult.class} is below the recorded baseline ${baseline.recorded_class}.`,
    });
  }

  const reasons = [...classResult.reasons];
  for (const finding of findings) {
    const reason = reasonFor(finding.code);
    if (reason !== undefined && !reasons.includes(reason)) reasons.push(reason);
  }

  return { findings, class: classResult.class, reasons };
}

function codeownersFindings(root: string, baseline: Baseline): DoctorFinding[] {
  const text = readTextSync(path.join(root, ".github/CODEOWNERS"));
  if (text === null) {
    return [{ code: "codeowners.missing", severity: "fail", message: "No .github/CODEOWNERS file." }];
  }
  if (!sizeOk(Buffer.byteLength(text))) {
    return [
      {
        code: "codeowners.too_large",
        severity: "fail",
        message: "CODEOWNERS is at or above 3 MB; GitHub does not load it.",
      },
    ];
  }

  const parsed = parseCodeowners(text);
  const findings: DoctorFinding[] = parsed.errors.map((error) => ({
    code: "codeowners.syntax",
    severity: "fail",
    message: `CODEOWNERS:${error.line} ${error.kind}: ${error.message}`,
  }));

  for (const coverage of coversPaths(parsed.rules, baseline.expected.protected_paths)) {
    if (coverage.owner === null) {
      findings.push({
        code: "codeowners.path_uncovered",
        severity: "fail",
        message: `${coverage.path} has no code owner.`,
      });
    }
  }
  return findings;
}

/**
 * GitHub reports a required check by its job name. Two workflows defining the
 * same job name make the context ambiguous, so the doctor refuses to claim G1.
 * The shipped workflow is identified by its content, not by a fixed file name:
 * adopters may rename it.
 */
function ambiguousWorkflowFindings(input: DoctorCheckInput): DoctorFinding[] {
  const files = new Set<string>();
  for (const name of input.workflowFiles) files.add(resolveWorkflow(input.root, name));
  for (const name of listWorkflowFiles(input.root)) files.add(resolveWorkflow(input.root, name));

  const shipped = input.workflowText.trim();
  const findings: DoctorFinding[] = [];
  for (const file of files) {
    const text = readTextSync(file);
    if (text === null || text.trim() === shipped) continue;
    const jobs = workflowJobs(text);
    if (jobs !== null && Object.hasOwn(jobs, "invariant-verdict")) {
      findings.push({
        code: "check.name_ambiguous",
        severity: "fail",
        message: `${path.relative(input.root, file)} also defines a job named invariant-verdict.`,
      });
    }
  }
  return findings;
}

function workflowJobs(text: string): Record<string, unknown> | null {
  const document = parseWorkflow(text);
  return asRecord(document?.["jobs"]);
}

function hasMergeGroup(text: string): boolean {
  const document = parseWorkflow(text);
  const on = document?.["on"];
  if (typeof on === "string") return on === "merge_group";
  if (Array.isArray(on)) return on.includes("merge_group");
  const value = asRecord(on);
  return value !== null && Object.hasOwn(value, "merge_group");
}

function parseWorkflow(text: string): Record<string, unknown> | null {
  try {
    return asRecord(parseYaml(text) as unknown);
  } catch {
    return null;
  }
}

function listWorkflowFiles(root: string): string[] {
  try {
    return readdirSync(path.join(root, ".github/workflows")).filter(
      (name) => name.endsWith(".yml") || name.endsWith(".yaml"),
    );
  } catch {
    return [];
  }
}

function resolveWorkflow(root: string, name: string): string {
  const normalized = name.replaceAll("\\", "/");
  return normalized.includes("/")
    ? path.resolve(root, normalized)
    : path.join(root, ".github/workflows", normalized);
}

function readTextSync(file: string): string | null {
  try {
    const text = readFileSync(file, "utf8");
    const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    return withoutBom.replace(/\r\n?/g, "\n");
  } catch {
    return null;
  }
}

function formatBypass(actor: { type: string; id: number | null; mode: string }): string {
  return `${actor.type}${actor.id === null ? "" : `#${actor.id}`} (${actor.mode})`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
