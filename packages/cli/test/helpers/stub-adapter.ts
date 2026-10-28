/**
 * In-memory `Adapter` for tests that need a deterministic discovery result or
 * check outcome. The CLI still exercises the real adapter by default; this is
 * for unit tests that do not want to spawn Vitest.
 */
import type { Adapter, CheckResult, RunOpts } from "../../src/adapter/api.js";
import { alignReportResults } from "../../src/adapter/align.js";
import type { DiscoveredCheck, DiscoveryResult } from "../../src/discovery/types.js";

export function stubAdapter(spec: {
  discovered: DiscoveredCheck[];
  results: CheckResult[];
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
  };
}
