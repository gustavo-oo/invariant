/**
 * Spec §9.1 — how binding this run's verdict is.
 *
 * This is the **only** class function in the codebase. `runDoctorChecks` feeds it
 * the `severity: "fail"` protection findings it observed; `verify`/`verdict`
 * feed it `observationAvailable: false` whenever no doctor result was supplied.
 * Nothing else may decide a class, or the two paths could disagree about G1.
 */

/** The three guarantee classes. G3 is never a guarantee. */
export type GuaranteeClass = "G1" | "G2" | "G3";

/**
 * G1 > G2 > G3, the only ordering the baseline regression gate may use.
 * Exported so `verdict` and `verify` compare a recorded class and a current
 * class the same way instead of each carrying its own table (R61).
 */
const CLASS_RANK: Record<GuaranteeClass, number> = { G3: 0, G2: 1, G1: 2 };

/** The rank of a class; a higher number is a stronger guarantee. */
export function classRank(cls: GuaranteeClass): number {
  return CLASS_RANK[cls];
}

/** A protection problem, reduced to what the class decision needs. */
export interface ClassFinding {
  code: string;
  message: string;
}

export interface ClassResult {
  class: GuaranteeClass;
  /** One human-readable line per input that lowered the class; empty only for G1. */
  reasons: string[];
  /** True for G1 and G2; a G3 verdict must never be described as binding. */
  binding: boolean;
}

/**
 * Compute the class from the three facts that decide it.
 *
 * - `G1` needs both an observation and zero protection findings. Any finding
 *   forces the class down even when the observation succeeded.
 * - `G2` is the fallback when the class is not G1 and the config declares a
 *   credential boundary: the agent cannot write to `main`, so the forge is not
 *   relied upon (PEND-2, an explicit human declaration).
 * - `G3` is everything else: visible on the PR, acting on it is a human's job.
 *
 * Callers must derive `observationAvailable` from the doctor result itself; a
 * class the observation does not support is a bug, and `buildReport` refuses a
 * G1 report without observed doctor evidence.
 *
 * @param credentialBoundary `true` when the config declares a boundary
 * (`config.credentialBoundary !== "none"`), not when it is merely possible.
 */
export function computeClass(input: {
  observationAvailable: boolean;
  protectionFindings: ClassFinding[];
  credentialBoundary: boolean;
}): ClassResult {
  const findings = input.protectionFindings;
  const observationLowered = !input.observationAvailable;
  const findingsLowered = findings.length > 0;

  const reachedG1 = !observationLowered && !findingsLowered;
  const cls: GuaranteeClass = reachedG1 ? "G1" : input.credentialBoundary ? "G2" : "G3";

  const reasons: string[] = [];
  if (observationLowered) {
    reasons.push("Branch-protection observation is unavailable, so the class cannot be G1.");
  }
  if (findingsLowered) {
    const codes = [...new Set(findings.map((finding) => finding.code))].sort();
    reasons.push(`Protection findings block a mechanical guarantee: ${codes.join(", ")}.`);
  }
  if (cls !== "G1" && !input.credentialBoundary) {
    reasons.push("No credential boundary is declared in .invariant/config.yaml, so the class cannot be G2.");
  }

  return { class: cls, reasons, binding: cls === "G1" || cls === "G2" };
}
