import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DiscoveredCheck } from "../../discovery/types.js";
import type { CheckResult, RunOpts } from "../api.js";
import { mapPlaywrightJson } from "./report.js";

const execFileAsync = promisify(execFile);

/** E2E suites are slower than unit tests; the adapter's own default is larger. */
const TIMEOUT_MS = 600_000;
const MAX_BUFFER = 20 * 1024 * 1024;

/**
 * Run the discovered Playwright checks through the project's own
 * `@playwright/test`, read the JSON report, and map every check back by
 * `runtimeId`. A check absent from the report is `not-run`, never green.
 */
export async function runPlaywrightChecks(
  checks: DiscoveredCheck[],
  opts: RunOpts,
): Promise<CheckResult[]> {
  if (checks.length === 0) return [];

  const root = await realpath(opts.root);
  const runOpts: RunOpts = { ...opts, root };
  const files = [...new Set(checks.map((check) => check.file))].sort();
  const directory = await mkdtemp(path.join(tmpdir(), "invariant-playwright-"));
  const outputFile = path.join(directory, "report.json");

  try {
    await runPlaywright(files, runOpts, outputFile);

    let json: unknown;
    try {
      json = JSON.parse(await readFile(outputFile, "utf8")) as unknown;
    } catch (cause) {
      throw new Error(`invariant: playwright produced no readable JSON report at ${outputFile}`, {
        cause,
      });
    }

    const located = mapPlaywrightJson(json);
    return checks.map((check) => {
      const match = located.find((result) => result.runtimeId === check.runtimeId);
      return match === undefined
        ? { runtimeId: check.runtimeId, outcome: "not-run", frameworkId: "playwright" }
        : { ...match, frameworkId: "playwright" };
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runPlaywright(files: string[], opts: RunOpts, outputFile: string): Promise<void> {
  const entry = path.join(opts.root, "node_modules", "@playwright", "test", "cli.js");
  if (!existsSync(entry)) {
    throw new Error(`invariant: @playwright/test is not installed at ${path.dirname(entry)}`);
  }

  const args = ["test", "--reporter=json", ...files];
  try {
    await execFileAsync(process.execPath, [entry, ...args], {
      cwd: opts.root,
      env: { ...(opts.env ?? process.env), PLAYWRIGHT_JSON_OUTPUT_NAME: outputFile },
      maxBuffer: MAX_BUFFER,
      timeout: opts.timeoutMs ?? TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (cause) {
    // A numeric exit code is a failing test; the report is the authority. A
    // spawn failure or a killed process has no exit code and must propagate.
    if (!isExitCode(cause)) {
      throw new Error(`invariant: could not run playwright: ${messageOf(cause)}`, { cause });
    }
  }
}

function isExitCode(cause: unknown): boolean {
  return typeof (cause as { code?: unknown }).code === "number";
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
