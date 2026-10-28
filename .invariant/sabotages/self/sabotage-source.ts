// @seam-alias packages/cli/src/seams/sabotage-source.ts
export function createSabotageSource() {
  return { read: async () => ({ text: "", seamAlias: null }) };
}
