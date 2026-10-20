import path from "node:path";
import type { DiscoveredCheck, DiscoveryError, DiscoveryResult } from "../../discovery/types.js";
import { readText } from "../../fsutil.js";
import type { Adapter, CheckResult, RunOpts } from "../api.js";
import { discoverTestFile, listTestFiles } from "./ast.js";
import { readReports as readVitestReports } from "./report.js";
import { runChecks } from "./run.js";

/**
 * Vitest discovery, execution and report reading. `run` delegates to
 * `runChecks`, which never turns an absent result green; `readReports` reads
 * reports left on disk so the pipeline can skip a re-run when one exists.
 */
export const vitestAdapter: Adapter = {
  id: "vitest",

  async discover(root: string): Promise<DiscoveryResult> {
    const checks: DiscoveredCheck[] = [];
    const errors: DiscoveryError[] = [];

    for (const file of await listTestFiles(root)) {
      let text: string;
      try {
        text = await readText(path.join(root, file));
      } catch (cause) {
        errors.push({ file, message: `could not read: ${messageOf(cause)}` });
        continue;
      }
      const found = discoverTestFile(file, text);
      checks.push(...found.checks);
      errors.push(...found.errors);
    }

    return { checks, errors };
  },

  async run(checks: DiscoveredCheck[], opts: RunOpts): Promise<CheckResult[]> {
    return runChecks(checks, opts);
  },

  async readReports(paths: string[], root: string): Promise<CheckResult[] | null> {
    return readVitestReports(paths, root);
  },
};

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
