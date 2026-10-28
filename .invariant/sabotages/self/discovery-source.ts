// @seam-alias packages/cli/src/seams/discovery-source.ts
export function createDiscoverySource() {
  return { id: "vitest", discover: async () => ({ checks: [], errors: [] }) };
}
