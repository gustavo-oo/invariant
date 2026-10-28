// @seam-alias packages/cli/src/seams/forge-probe.ts
export function createForgeProbe() {
  return {
    observe: async () => ({
      available: true,
      repo: { owner: "o", name: "r", defaultBranch: "main", visibility: "public" },
      protection: {
        mechanism: "none",
        requiredContexts: [],
        codeOwnerReview: false,
        bypassActors: [],
        mergeQueue: "unknown",
      },
    }),
  };
}
