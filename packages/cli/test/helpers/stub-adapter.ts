/**
 * In-memory `Adapter` for tests that need a deterministic discovery result or
 * check outcome. The CLI still exercises the real adapter by default; this is
 * for unit tests that do not want to spawn Vitest.
 *
 * `sabotageOutcomes` is keyed by check id and defaults to `not-executed`;
 * `classifications` overrides the conservative message classifier.
 */
import type { Adapter, CheckResult, RunOpts, SabotageSpec } from "../../src/adapter/api.js";
import { alignReportResults } from "../../src/adapter/align.js";
import type { DiscoveredCheck, DiscoveryResult } from "../../src/discovery/types.js";
import type { SabotageOutcome } from "../../src/verdict/types.js";

export function stubAdapter(spec: {
  discovered: DiscoveredCheck[];
  results: CheckResult[];
  sabotageOutcomes?: Map<string, SabotageOutcome>;
  classifications?: Map<string, "assertion" | "harness" | "timeout">;
}): Adapter {
  return {
    id: "stub",
    async discover(): Promise<DiscoveryResult> {
      return { checks: spec.discovered, errors: [] };
    },
    async run(checks: DiscoveredCheck[], _opts: RunOpts): Promise<CheckResult[]> {
      return alignReportResults(checks, spec.results);
    },
    async readReports(_paths: string[], _root: string): Promise<CheckResult[] | null> {
      return spec.results;
    },
    async applySabotage(sabotage: SabotageSpec): Promise<SabotageOutcome> {
      return spec.sabotageOutcomes?.get(sabotage.check.checkId) ?? { status: "not-executed" };
    },
    classifyFailure(result: CheckResult): "assertion" | "harness" | "timeout" {
      const override = spec.classifications?.get(result.runtimeId);
      if (override !== undefined) return override;
      return /AssertionError|expected .* to (be|equal|include|match|throw|have)/.test(result.message ?? "")
        ? "assertion"
        : "harness";
    },
  };
}
