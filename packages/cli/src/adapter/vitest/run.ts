import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DiscoveredCheck } from "../../discovery/types.js";
import { toPosix } from "../../fsutil.js";
import type { CheckResult, RunOpts } from "../api.js";
import { collectResults } from "./report.js";

const execFileAsync = promisify(execFile);

/** A hung suite must not hang the verifier forever. */
const TIMEOUT_MS = 120_000;

/** Generous headroom for the JSON reporter's output on a large suite. */
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Run every given check with one Vitest invocation and map the JSON report back
 * to one result per check. Files are deduplicated and sorted so the caller's
 * order cannot multiply the run. Presence is decided per check file: a check
 * whose file never appears in the report, or whose `runtimeId` is absent from
 * that file, is `not-run` — absent is never green.
 *
 * `--retry=0` is deliberate: no silent retry-until-green (spec §6). Flakiness is
 * only visible when a report already records retries (`readReports`), never
 * manufactured by our own run.
 */
export async function runChecks(checks: DiscoveredCheck[], opts: RunOpts): Promise<CheckResult[]> {
  if (checks.length === 0) return [];

  // Canonicalize before anything path-sensitive: Vitest reports absolute real
  // paths, so a symlinked or otherwise non-canonical root makes every reported
  // file look foreign and silently degrades every check to `not-run`. Carried
  // fix from Task 6's review.
  const root = await realpath(opts.root);
  const runOpts: RunOpts = { ...opts, root };

  const files = [...new Set(checks.map((check) => check.file))].sort();
  const directory = await mkdtemp(path.join(tmpdir(), "invariant-vitest-"));
  const outputFile = path.join(directory, "report.json");

  try {
    const stderr = await runVitest(files, runOpts, outputFile);

    let json: unknown;
    try {
      json = JSON.parse(await readFile(outputFile, "utf8")) as unknown;
    } catch (cause) {
      // No trustworthy report: the run itself is broken, not the product. The
      // child's stderr says why (config crash, bad flag), so carry it into the
      // diagnostic instead of reporting only the temp path. Task 7 turns this
      // into EXIT.GATE_BROKEN.
      const detail = stderr.trim();
      const suffix = detail.length === 0 ? "" : `\n${detail}`;
      throw new Error(`invariant: vitest produced no readable JSON report at ${outputFile}${suffix}`, {
        cause,
      });
    }

    const located = collectResults(json, root);
    const results: CheckResult[] = [];
    for (const check of checks) {
      // Presence is per check file: a same-named test in another file is a
      // different check, and must never lend this one its outcome.
      const file = toPosix(path.normalize(check.file));
      const match = located.find(
        (candidate) => candidate.file === file && candidate.result.runtimeId === check.runtimeId,
      );
      results.push(match?.result ?? { runtimeId: check.runtimeId, outcome: "not-run" });
    }
    return results;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runVitest(files: string[], opts: RunOpts, outputFile: string): Promise<string> {
  const args = ["run", "--reporter=json", `--outputFile=${outputFile}`, "--retry=0", ...files];
  try {
    const { stderr } = await execFileAsync(process.execPath, [vitestEntry(opts.root), ...args], {
      cwd: opts.root,
      env: { ...process.env, ...opts.env },
      maxBuffer: MAX_BUFFER,
      timeout: TIMEOUT_MS,
      windowsHide: true,
    });
    return stderr;
  } catch (cause) {
    // A numeric exit code is how Vitest reports failing checks, and that is
    // expected: the JSON report is the authority and is read by the caller.
    // A timeout (killed), a signal, or a failed spawn has no exit code and
    // must propagate instead of being mistaken for a red check.
    if (!isExitCode(cause)) {
      throw new Error(`invariant: could not run vitest: ${messageOf(cause)}`, { cause });
    }
    const stderr = (cause as { stderr?: unknown }).stderr;
    return typeof stderr === "string" ? stderr : "";
  }
}

/**
 * The project's own Vitest. The plan's contract is
 * `node <root>/node_modules/vitest/vitest.mjs`; there is deliberately no
 * fallback to Invariant's install, because running a project's tests under a
 * different Vitest version is version skew, not a rescue.
 */
function vitestEntry(root: string): string {
  const directory = path.join(root, "node_modules", "vitest");
  if (!existsSync(directory)) {
    throw new Error(`invariant: vitest is not installed at ${directory}`);
  }
  return path.join(directory, "vitest.mjs");
}

function isExitCode(cause: unknown): boolean {
  return typeof (cause as { code?: unknown }).code === "number";
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
