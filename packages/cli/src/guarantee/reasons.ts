/**
 * Human reasons for doctor findings and class meanings (spec §9.3 item 7).
 *
 * The codes are the machine contract; these strings are what the doctor prints
 * and what the PR report carries. Keeping them here prevents the command and the
 * checks from growing two vocabularies.
 */
import type { GuaranteeClass } from "./class.js";

export const DOCTOR_REASONS: Record<string, string> = {
  "protection.unavailable": "Branch-protection observation is unavailable.",
  "protection.none": "No branch protection or ruleset covers the default branch.",
  "protection.no_required_check": "The required status check is not required on the default branch.",
  "check.not_pinned_to_app": "The required check is not pinned to the expected GitHub App.",
  "codeowners.missing": "The repository has no .github/CODEOWNERS file.",
  "codeowners.too_large": "CODEOWNERS is at or above GitHub's 3 MB limit and is not loaded.",
  "codeowners.syntax": "CODEOWNERS contains a line GitHub would silently skip.",
  "codeowners.path_uncovered": "A protected path has no code owner.",
  "codeowners.review_not_required": "Protection does not require review from code owners.",
  "bypass.grew": "The branch-protection bypass list grew since the recorded baseline.",
  "bypass.present": "The branch-protection bypass list is not empty.",
  "merge_queue.workflow_missing_trigger": "A merge queue is enabled but the workflow does not run on merge_group.",
  "check.name_ambiguous": "More than one workflow defines a job named invariant-verdict.",
  "baseline.regressed": "The observed guarantee class is below the recorded baseline.",
};

export function reasonFor(code: string): string | undefined {
  return DOCTOR_REASONS[code];
}

export function classMeaning(cls: GuaranteeClass): string {
  switch (cls) {
    case "G1":
      return "mechanical: the required check blocks the merge.";
    case "G2":
      return "credential: the agent cannot write to main; the forge is not relied upon.";
    case "G3":
      return "procedural: the verdict is visible on the PR; a human must act on it.";
  }
}

export const MECHANISM_LABEL: Record<"ruleset" | "branch-protection" | "none", string> = {
  ruleset: "ruleset",
  "branch-protection": "classic branch protection",
  none: "none",
};
