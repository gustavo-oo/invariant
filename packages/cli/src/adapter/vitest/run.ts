import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DiscoveredCheck } from "../../discovery/types.js";
import type { CheckResult, RunOpts } from "../api.js";
import { mapVitestJson } from "./report.js";

const execFileAsync = promisify(execFile);

/** A hung suite must not hang the verifier forever. */
const TIMEOUT_MS = 120_000;

/** Generous headroom for the JSON reporter's output on a large suite. */
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Run every given check with one Vitest invocation and map the JSON report back
 * to checks. Files are deduplicated and sorted so the caller's order cannot
 * multiply the run. A check with no matching result in the report is `not-run`;
 * absent is never green.
 *
 * `--retry=0` is deliberate: no silent retry-until-green (spec §6). Flakiness is
 * only visible when a report already records retries (`readReports`), never
 * manufactured by our own run.
 */
export async function runChecks(checks: DiscoveredCheck[], opts: RunOpts): Promise<CheckResult[]> {
  if (checks.length === 0) return [];

  const files = [...new Set(checks.map((check) => check.file))].sort();
  const directory = await mkdtemp(path.join(tmpdir(), "invariant-vitest-"));
  const outputFile = path.join(directory, "report.json");

  try {
    await runVitest(files, opts, outputFile);

    let json: unknown;
    try {
      json = JSON.parse(await readFile(outputFile, "utf8")) as unknown;
    } catch (cause) {
      // No trustworthy report: the run itself is broken, not the product. Task 7
      // turns this into EXIT.GATE_BROKEN.
      throw new Error(`invariant: vitest produced no readable JSON report at ${outputFile}`, { cause });
    }

    const wanted = new Set(checks.map((check) => check.runtimeId));
    const results = mapVitestJson(json).filter((result) => wanted.has(result.runtimeId));
    const seen = new Set(results.map((result) => result.runtimeId));
    for (const check of checks) {
      if (!seen.has(check.runtimeId)) results.push({ runtimeId: check.runtimeId, outcome: "not-run" });
    }
    return results;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runVitest(files: string[], opts: RunOpts, outputFile: string): Promise<void> {
  const args = ["run", "--reporter=json", `--outputFile=${outputFile}`, "--retry=0", ...files];
  try {
    await execFileAsync(process.execPath, [vitestEntry(opts.root), ...args], {
      cwd: opts.root,
      env: { ...process.env, ...opts.env },
      maxBuffer: MAX_BUFFER,
      timeout: TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (cause) {
    // A numeric exit code is how Vitest reports failing checks, and that is
    // expected: the JSON report is the authority and is read by the caller.
    // A timeout (killed), a signal, or a failed spawn has no exit code and
    // must propagate instead of being mistaken for a red check.
    if (!isExitCode(cause)) {
      throw new Error(`invariant: could not run vitest: ${messageOf(cause)}`, { cause });
    }
  }
}

/**
 * The project's own Vitest, so the adapter honours the version the repo pinned.
 * Falling back to this package's install keeps in-repo fixtures without a
 * `node_modules` (see `makeTmpRepo`) runnable.
 */
function vitestEntry(root: string): string {
  const local = path.join(root, "node_modules", "vitest", "vitest.mjs");
  if (existsSync(local)) return local;
  return createRequire(import.meta.url).resolve("vitest/vitest.mjs");
}

function isExitCode(cause: unknown): boolean {
  return typeof (cause as { code?: unknown }).code === "number";
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
