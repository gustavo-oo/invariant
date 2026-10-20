import path from "node:path";
import type { DiscoveredCheck, DiscoveryError, DiscoveryResult } from "../../discovery/types.js";
import { readText } from "../../fsutil.js";
import type { Adapter, CheckResult, RunOpts } from "../api.js";
import { discoverTestFile, listTestFiles } from "./ast.js";

const RUN_NOT_IMPLEMENTED =
  "the vitest adapter's run is not implemented in this task; it is wired by the next task (adapter run)";
const REPORTS_NOT_IMPLEMENTED =
  "the vitest adapter's readReports is not implemented in this task; it is wired by the next task (adapter run)";

/**
 * Vitest discovery. `run` and `readReports` satisfy the fixed `Adapter` seam but
 * deliberately throw until the "adapter run" task implements them: returning a
 * fake result here would let a later pipeline mistake "not wired" for "green".
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

  async run(_checks: DiscoveredCheck[], _opts: RunOpts): Promise<CheckResult[]> {
    throw new Error(RUN_NOT_IMPLEMENTED);
  },

  async readReports(_paths: string[], _root: string): Promise<CheckResult[] | null> {
    throw new Error(REPORTS_NOT_IMPLEMENTED);
  },
};

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
