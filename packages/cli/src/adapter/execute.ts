/**
 * Execute a mixed set of checks through their adapters.
 *
 * Reports are tried first, per adapter, and only for the adapters that own the
 * checks. A report named `<adapter>=<path>` is routed to that adapter only; an
 * unprefixed path is offered to every adapter (a Vitest JSON is ignored by the
 * Playwright reader, and vice versa). An adapter with no readable report runs
 * its own checks.
 */
import type { Adapter, CheckResult, RunOpts } from "./api.js";
import { alignReportResults } from "./align.js";
import type { DiscoveredCheck } from "../discovery/types.js";
import { createCheckRunner } from "../seams/check-runner.js";

export async function executeAdapters(
  adapters: Adapter[],
  checks: DiscoveredCheck[],
  opts: RunOpts,
  reports: string[],
): Promise<CheckResult[] | { error: string }> {
  if (checks.length === 0) return [];

  const groups = new Map<string, DiscoveredCheck[]>();
  for (const check of checks) {
    const group = groups.get(check.frameworkId);
    if (group === undefined) groups.set(check.frameworkId, [check]);
    else group.push(check);
  }

  const byFramework = new Map<string, CheckResult[]>();
  for (const [frameworkId, group] of groups) {
    const adapter = adapters.find((candidate) => candidate.id === frameworkId);
    if (adapter === undefined) {
      return { error: `invariant: unknown adapter: ${frameworkId}` };
    }

    const paths = reportsForAdapter(reports, frameworkId);
    const reported = paths.length > 0 ? await adapter.readReports(paths, opts.root) : null;
    if (reported !== null) {
      byFramework.set(frameworkId, alignReportResults(group, reported));
      continue;
    }

    const ran = await createCheckRunner(adapter).run(group, opts);
    if (!Array.isArray(ran)) return ran;
    byFramework.set(frameworkId, ran);
  }

  return checks.map((check) => {
    const group = groups.get(check.frameworkId) ?? [];
    const index = group.indexOf(check);
    const result = byFramework.get(check.frameworkId)?.[index];
    return result === undefined
      ? { runtimeId: check.runtimeId, outcome: "not-run", frameworkId: check.frameworkId }
      : { ...result, frameworkId: check.frameworkId };
  });
}

/** `<adapter>=<path>` routes one report; an unprefixed path is common. */
function reportsForAdapter(reports: string[], adapterId: string): string[] {
  const prefix = `${adapterId}=`;
  return reports.flatMap((report) => {
    if (report.startsWith(prefix)) return [report.slice(prefix.length)];
    if (report.includes("=")) return [];
    return [report];
  });
}
