/**
 * The tool version that goes into `invariant-report.json`.
 *
 * It is a literal because the report must stay byte-identical regardless of how
 * the CLI was built or installed; `packages/cli/package.json` is the publication
 * source of truth and a unit test keeps the two in sync.
 */
export const TOOL_VERSION = "0.1.0";
