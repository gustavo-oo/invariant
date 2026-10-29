// @seam-alias packages/cli/src/seams/check-runner.ts
// EVIDENCE-ONLY HARNESS ERROR (branch phase-2-evidence-harness, never merged).
//
// This file is intentionally not valid TypeScript. The sabotaged run must fail
// to load its own seam, be classified `harness`, and never count as proof.
export function createCheckRunner() {
  return {
    run: async (checks) => checks.map((check) => ({ runtimeId: check.runtimeId, outcome: "pass" })
