/**
 * Run the built CLI in a throw-away copy of an integration fixture, so tests
 * exercise the real entry point (argv, cwd, streams, exit code) without ever
 * mutating `test/fixtures`.
 *
 * The CLI runs with the copy as its `cwd` and therefore needs no `--root`; a
 * fixture's relative paths are its repo-relative paths.
 */
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExitCode } from "../../src/exit.js";
import type { DoctorResult } from "../../src/commands/doctor.js";
import type { Baseline } from "../../src/doctor/baseline.js";
import type { Report } from "../../src/report/shape.js";
import { isReport } from "./goldens.js";
import { linkNodeModules } from "./node-modules.js";

/** Absolute path of the built CLI. `npm test` builds before running the suite. */
export const CLI_PATH = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

export interface FixtureRun {
  exitCode: ExitCode;
  stdout: string;
  stderr: string;
  /** Parsed `invariant-report.json`, when the run produced one. */
  report: Report | null;
  /** Contents of `invariant-comment.md`, when the run produced one. */
  comment: string | null;
  /** Parsed `invariant-doctor.json`, when the run produced one. */
  doctor: DoctorResult | null;
  /** Parsed `.invariant/protection-baseline.json`, when the run produced one. */
  baseline: Baseline | null;
  /** Real path of the copied fixture that was used as the working directory. */
  root: string;
}

export async function spawnCli(
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<{ exitCode: ExitCode; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    // No shell: every argument reaches the CLI verbatim.
    const child = spawn(process.execPath, [CLI_PATH, ...args], { cwd: opts.cwd, env: opts.env ?? process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === null) {
        reject(new Error(`invariant: ${CLI_PATH} was terminated by a signal`));
        return;
      }
      if (code !== 0 && code !== 1 && code !== 2) {
        reject(new Error(`invariant: ${CLI_PATH} exited with unexpected code ${code}`));
        return;
      }
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

/**
 * Copy `test/fixtures/<name>` to a fresh temp directory and run the CLI there.
 * Defaults to the `validate` command; pass `args` for other commands.
 *
 * `env` is the child's complete environment (default: the test's own), so a
 * caller that needs a hermetic CI context can supply a scrubbed copy instead of
 * relying on what the developer's shell or the Actions runner exported.
 */
export async function runFixture(
  name: string,
  opts: { args?: string[]; env?: NodeJS.ProcessEnv } = {},
): Promise<FixtureRun> {
  const holder = await mkdtemp(path.join(tmpdir(), "invariant-fixture-"));
  const copy = path.join(holder, name);
  await cp(path.join(FIXTURES, name), copy, { recursive: true });
  const root = await realpath(copy);
  // A fixture is a real repo: give it the workspace install so its tests can
  // execute offline, exactly like `makeVitestRepo` does.
  await linkNodeModules(root);

  const run = await spawnCli(opts.args ?? ["validate"], { cwd: root, env: opts.env });
  return {
    ...run,
    report: await readReport(root),
    comment: await readComment(root),
    doctor: await readDoctor(root),
    baseline: await readBaselineFile(root),
    root,
  };
}

async function readReport(root: string): Promise<Report | null> {
  const file = path.join(root, "invariant-report.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!isReport(parsed)) throw new Error(`invariant: ${file} is not an invariant report`);
    return parsed;
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw cause;
  }
}

async function readComment(root: string): Promise<string | null> {
  try {
    return await readFile(path.join(root, "invariant-comment.md"), "utf8");
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw cause;
  }
}

async function readDoctor(root: string): Promise<DoctorResult | null> {
  const file = path.join(root, "invariant-doctor.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return isDoctorResult(parsed) ? parsed : null;
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw cause;
  }
}

async function readBaselineFile(root: string): Promise<Baseline | null> {
  const file = path.join(root, ".invariant/protection-baseline.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return isBaseline(parsed) ? parsed : null;
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw cause;
  }
}

function isDoctorResult(value: unknown): value is DoctorResult {
  return (
    isRecord(value) &&
    value["schema_version"] === 1 &&
    (value["repo"] === null || typeof value["repo"] === "string") &&
    (value["run_id"] === null || typeof value["run_id"] === "string") &&
    typeof value["class"] === "string" &&
    Array.isArray(value["reasons"]) &&
    Array.isArray(value["findings"]) &&
    isRecord(value["observation"])
  );
}

function isBaseline(value: unknown): value is Baseline {
  return (
    isRecord(value) &&
    value["schema_version"] === 1 &&
    typeof value["recorded_class"] === "string" &&
    isRecord(value["expected"])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(cause: unknown): boolean {
  return cause instanceof Error && (cause as NodeJS.ErrnoException).code === "ENOENT";
}
