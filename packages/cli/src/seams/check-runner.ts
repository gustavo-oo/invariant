import type { Adapter, CheckResult, RunOpts } from "../adapter/api.js";
import type { DiscoveredCheck } from "../discovery/types.js";

/**
 * The outcome of asking the runner to execute checks: an aligned result list on
 * success, or one gate diagnostic when the adapter itself could not run. The
 * union is what lets `run` distinguish "the product is broken" (a result) from
 * "the gate is broken" (no trustworthy result), instead of swallowing a spawn
 * failure into a missing check.
 */
export type CheckRunOutcome = CheckResult[] | { error: string };

/**
 * The execution seam `verify` and `negative` consume. SELF-001's sabotage
 * replaces this module (Task 23), so it deliberately holds no policy: it is a
 * passthrough that turns a thrown adapter failure into the error union.
 */
export interface CheckRunner {
  run(checks: DiscoveredCheck[], opts: RunOpts): Promise<CheckRunOutcome>;
}

export function createCheckRunner(adapter: Adapter): CheckRunner {
  return {
    async run(checks: DiscoveredCheck[], opts: RunOpts): Promise<CheckRunOutcome> {
      try {
        return await adapter.run(checks, opts);
      } catch (cause) {
        return { error: gateDiagnostic(cause) };
      }
    },
  };
}

/**
 * Adapter failures are already user-facing (`runChecks` prefixes its own). A
 * bare message from a future adapter gets the same marker so stderr always says
 * who is reporting, and exactly once.
 */
function gateDiagnostic(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.startsWith("invariant:") ? message : `invariant: ${message}`;
}
