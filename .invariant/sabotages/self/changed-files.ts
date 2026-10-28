// @seam-alias packages/cli/src/seams/changed-files.ts
export function createChangedFilesProvider() {
  return { changedFiles: async () => ({ base: "", head: "", files: [] }) };
}
