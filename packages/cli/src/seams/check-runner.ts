import type { Adapter, CheckResult, RunOpts } from "../adapter/api.js";
import type { DiscoveredCheck } from "../discovery/types.js";

/**
 * The outcome of asking the runner to execute checks: an aligned result list on
 * success, or one gate diagnostic when an adapter itself could not run. The
 * union is what lets `run`/`verify` distinguish "the product is broken" from
 * "the gate is broken".
 */
export type CheckRunOutcome = CheckResult[] | { error: string };

/**
 * The execution seam `verify` and `negative` consume. It accepts one adapter
 * or the configured list, groups checks by `frameworkId`, and preserves the
 * caller's order in the returned results.
 */
export interface CheckRunner {
  run(checks: DiscoveredCheck[], opts: RunOpts): Promise<CheckRunOutcome>;
}

export function createCheckRunner(adapters: Adapter | Adapter[]): CheckRunner {
  const list = Array.isArray(adapters) ? adapters : [adapters];

  return {
    async run(checks: DiscoveredCheck[], opts: RunOpts): Promise<CheckRunOutcome> {
      const groups = new Map<string, DiscoveredCheck[]>();
      for (const check of checks) {
        const group = groups.get(check.frameworkId);
        if (group === undefined) groups.set(check.frameworkId, [check]);
        else group.push(check);
      }

      const byFramework = new Map<string, CheckResult[]>();
      for (const [frameworkId, group] of groups) {
        const adapter = list.find((candidate) => candidate.id === frameworkId);
        if (adapter === undefined) {
          return { error: `invariant: unknown adapter: ${frameworkId}` };
        }
        try {
          byFramework.set(frameworkId, await adapter.run(group, opts));
        } catch (cause) {
          return { error: gateDiagnostic(cause) };
        }
      }

      return checks.map((check) => {
        const group = groups.get(check.frameworkId) ?? [];
        const index = group.indexOf(check);
        const result = byFramework.get(check.frameworkId)?.[index];
        return result === undefined
          ? { runtimeId: check.runtimeId, outcome: "not-run", frameworkId: check.frameworkId }
          : { ...result, frameworkId: check.frameworkId };
      });
    },
  };
}

/** Adapter failures are already user-facing; prefix a bare message once. */
function gateDiagnostic(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.startsWith("invariant:") ? message : `invariant: ${message}`;
}
