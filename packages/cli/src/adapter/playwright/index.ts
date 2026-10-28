import path from "node:path";
import type { Adapter, CheckResult, RunOpts, SabotageSpec } from "../api.js";
import type { DiscoveredCheck, DiscoveryError, DiscoveryResult } from "../../discovery/types.js";
import { readText } from "../../fsutil.js";
import { isPlaywrightFile } from "../detect.js";
import { classifyFailureMessage } from "../failure.js";
import { applySabotageInCopy } from "../sabotage.js";
import { discoverTestFile, listTestFiles } from "../vitest/ast.js";
import { readPlaywrightReports } from "./report.js";
import { runPlaywrightChecks } from "./run.js";

/** Playwright discovery, execution, report reading and sabotage. */
export const playwrightAdapter: Adapter = {
  id: "playwright",

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
      if (!isPlaywrightFile(text)) continue;
      const found = discoverTestFile(file, text, {
        frameworkId: "playwright",
        playwright: true,
      });
      checks.push(...found.checks);
      errors.push(...found.errors);
    }

    return { checks, errors };
  },

  async run(checks: DiscoveredCheck[], opts: RunOpts): Promise<CheckResult[]> {
    return runPlaywrightChecks(checks, opts);
  },

  async readReports(paths: string[], root: string): Promise<CheckResult[] | null> {
    return readPlaywrightReports(paths, root);
  },

  async applySabotage(spec: SabotageSpec) {
    return applySabotageInCopy(spec, runPlaywrightChecks);
  },

  classifyFailure(result: CheckResult): "assertion" | "harness" | "timeout" {
    return classifyFailureMessage(result.outcome, result.message);
  },
};

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
