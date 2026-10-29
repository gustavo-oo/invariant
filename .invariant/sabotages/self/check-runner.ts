// @seam-alias packages/cli/src/seams/check-runner.ts
// EVIDENCE-ONLY NO-OP (branch phase-2-evidence-noop, never merged).
//
// SELF-001's check asserts that `not-run` is a failure for an enforced rule.
// This runner reports every check as `not-run`, which is what that check's own
// fixture already expects, so the check stays green under sabotage. The control
// must therefore refuse to call SELF-001 proven: the rule is `blocked`.
export function createCheckRunner() {
  return {
    run: async (checks: { runtimeId: string; frameworkId: string }[]) =>
      checks.map((check) => ({
        runtimeId: check.runtimeId,
        outcome: "not-run",
        frameworkId: check.frameworkId,
      })),
  };
}
