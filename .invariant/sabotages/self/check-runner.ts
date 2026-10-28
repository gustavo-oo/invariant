// @seam-alias packages/cli/src/seams/check-runner.ts
export function createCheckRunner() {
  return {
    run: async (checks: { runtimeId: string }[]) =>
      checks.map((check) => ({ runtimeId: check.runtimeId, outcome: "pass" })),
  };
}
