/**
 * The negative-control decision table (spec §7, SELF-004).
 *
 * A sabotage that was applied and made the check fail is not automatically
 * proof: if the failure came from a harness error, a compile error or a timeout,
 * the check never exercised the seam. Only an `assertion`-classified failure is
 * evidence that the rule's own assertion can catch a broken collaborator.
 *
 * In this delivery (Phase 0/1, PEND-1) nothing produces an outcome other than
 * `not-executed`, so every rule is at most "checked", never "proven".
 */
import type { SabotageOutcome } from "./types.js";

/** True only for an applied sabotage whose failure was an assertion failure. */
export function isProof(outcome: SabotageOutcome): boolean {
  return outcome.status === "applied" && outcome.classification === "assertion";
}
