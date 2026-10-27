/**
 * `invariant run` — spec §8 stage 5: discover the checks the registry's tests
 * declare, execute them (or read a report a previous run left behind), and turn
 * those results into an exit code.
 *
 * The registry is the single source of truth: it is loaded and §5-validated
 * first, so a run over an invalid registry is exit 2 with findings and no check
 * lines at all. `not-run`, `fail` and `flaky` are all "the product is broken"
 * (exit 1); only a run where every check passed is green. A gate that finds no
 * checks to execute is never green either — except for a registry with zero
 * enforced rules, which is legal and says so.
 *
 * `--base` and `--event` are accepted and ignored here, exactly as `validate`
 * does: immutability and event handling belong to the verify pipeline.
 */
import path from "node:path";
import type { Adapter, CheckResult } from "../adapter/api.js";
import { findAdapter } from "../adapter/registry.js";
import { loadConfig } from "../config/load.js";
import type { DiscoveredCheck, DiscoveryError } from "../discovery/types.js";
import { EXIT, type ExitCode } from "../exit.js";
import { stringifyJson, writeOut, type CliIo } from "../output.js";
import { loadRegistry } from "../registry/load.js";
import { validateRegistry, type Finding } from "../registry/validate.js";
import { createCheckRunner } from "../seams/check-runner.js";
import { createDiscoverySource } from "../seams/discovery-source.js";

const HELP = `invariant run - execute the checks discovered for rules/**

Usage:
  invariant run [--root <dir>] [--adapter <id>] [--reports <file>]... [--json] [--out <file>]

Options:
      --root <dir>      Repository root (default: the current directory).
      --adapter <id>    Override the configured test-framework adapter.
      --reports <file>  Read results from a report instead of executing.
                        Repeatable; the first readable report wins. Reports are
                        always read before any test run.
      --base <ref>      Accepted and ignored by run; immutability is checked by
                        the verify pipeline.
      --event <path>    Accepted and ignored by run; event handling is part of
                        the verify pipeline.
      --json            Emit {"checks": CheckResult[]} instead of one line per check.
      --out <file>      Write the JSON artifact {"checks": CheckResult[]} to a file.
  -h, --help            Print this help.

Each check is printed as <checkId> <runtimeId> <outcome>.

Exit codes:
  0  Every executed check passed, or the registry declares no enforced rules.
  1  A check failed, was not run, or was flaky; or no checks were discovered.
  2  The registry is invalid, the adapter failed, or the verifier could not run.
`;

interface Options {
  root: string;
  adapter: string | null;
  reports: string[];
  json: boolean;
  out: string | null;
}

export async function run(argv: string[], io: CliIo): Promise<ExitCode> {
  const parsed = parseArgs(argv, io);
  if (parsed.kind === "exit") return parsed.code;
  const options = parsed.options;

  const { config, findings: configFindings } = await loadConfig(options.root);
  const effectiveConfig = options.adapter === null ? config : { ...config, adapter: options.adapter };
  const { registry, findings: registryFindings } = await loadRegistry(options.root);
  const findings = [
    ...configFindings,
    ...registryFindings,
    ...validateRegistry(registry, { cwd: options.root, config: effectiveConfig }),
  ];

  if (findings.length > 0) {
    // Never a verdict over a registry that is not the source of truth.
    io.stderr(findingsText(findings));
    return EXIT.GATE_BROKEN;
  }

  if (registry.rules.filter((rule) => rule.status === "enforced").length === 0) {
    // A registry that enforces nothing is legal; say so instead of claiming a
    // green it never checked. There is nothing to discover or execute.
    emit("0 enforced rules\n", stringifyJson({ checks: [] }), options, io);
    return EXIT.GREEN;
  }

  const source = createDiscoverySource(effectiveConfig);
  const discovery = await source.discover(options.root);
  if (discovery.errors.length > 0) {
    // A discovery problem is the gate's failure, not a red rule: execute
    // nothing, because no verdict over a half-read suite can be trusted.
    io.stderr(discoveryErrorsText(discovery.errors));
    return EXIT.GATE_BROKEN;
  }

  const adapter = findAdapter(source.id);
  if (adapter === undefined) {
    // `createDiscoverySource` already reports an unknown adapter as a discovery
    // error; keep this branch explicit rather than crashing if that ever drifts.
    io.stderr(`invariant run: unknown adapter: ${source.id}\n`);
    return EXIT.GATE_BROKEN;
  }

  if (discovery.checks.length === 0) {
    // Enforced rules exist but nothing implements them. A vacuous green is the
    // one failure mode a verifier must never have.
    emit("0 checks discovered\n", stringifyJson({ checks: [] }), options, io);
    return EXIT.PRODUCT_BROKEN;
  }

  const executed = await execute(adapter, discovery.checks, options);
  if (!Array.isArray(executed)) {
    io.stderr(`${executed.error}\n`);
    return EXIT.GATE_BROKEN;
  }
  const results = align(discovery.checks, executed);

  const lines = discovery.checks
    .map((check, index) => `${check.checkId} ${check.runtimeId} ${results[index]?.outcome ?? "not-run"}\n`)
    .join("");
  emit(lines, stringifyJson({ checks: results }), options, io);

  return results.length > 0 && results.every((result) => result.outcome === "pass")
    ? EXIT.GREEN
    : EXIT.PRODUCT_BROKEN;
}

/**
 * A report on disk is preferred over a fresh run (spec §6, "read before
 * re-run"). `readReports` returns `null` when none of the paths is usable, and
 * only then does the adapter execute. Task 6's `runChecks` returns exactly one
 * result per check in input order, so those results are zipped by index; a
 * report has no check ids at all and is matched by `runtimeId` instead.
 */
async function execute(
  adapter: Adapter,
  checks: DiscoveredCheck[],
  options: Options,
): Promise<CheckResult[] | { error: string }> {
  if (options.reports.length > 0) {
    const reported = await adapter.readReports(options.reports, options.root);
    if (reported !== null) return fromReport(checks, reported);
  }
  return await createCheckRunner(adapter).run(checks, { root: options.root });
}

/** Align a file-less report with the discovered checks; first match wins. */
function fromReport(checks: DiscoveredCheck[], results: CheckResult[]): CheckResult[] {
  return checks.map(
    (check) => results.find((result) => result.runtimeId === check.runtimeId) ?? notRun(check),
  );
}

/**
 * One result per discovered check, in discovery order. `runChecks` already
 * guarantees this; the fill keeps a shorter result list from being either
 * printed or counted as green.
 */
function align(checks: DiscoveredCheck[], results: CheckResult[]): CheckResult[] {
  return checks.map((check, index) => results[index] ?? notRun(check));
}

function notRun(check: DiscoveredCheck): CheckResult {
  return { runtimeId: check.runtimeId, outcome: "not-run" };
}

function parseArgs(argv: string[], io: CliIo): { kind: "ok"; options: Options } | { kind: "exit"; code: ExitCode } {
  let root = io.cwd;
  let adapter: string | null = null;
  const reports: string[] = [];
  let json = false;
  let out: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) break;
    switch (arg) {
      case "-h":
      case "--help":
        io.stdout(HELP);
        return { kind: "exit", code: EXIT.GREEN };
      case "--json":
        json = true;
        break;
      case "--root":
      case "--adapter":
      case "--reports":
      case "--out":
      case "--base":
      case "--event": {
        const value = argv[index + 1];
        if (value === undefined) {
          io.stderr(`invariant run: ${arg} requires a value\n`);
          return { kind: "exit", code: EXIT.GATE_BROKEN };
        }
        index += 1;
        if (arg === "--root") root = path.resolve(io.cwd, value);
        else if (arg === "--adapter") adapter = value;
        else if (arg === "--reports") reports.push(value);
        else if (arg === "--out") out = value;
        // --base and --event are accepted and ignored in this task.
        break;
      }
      default:
        io.stderr(`invariant run: unknown argument ${arg}\n`);
        return { kind: "exit", code: EXIT.GATE_BROKEN };
    }
  }

  return { kind: "ok", options: { root, adapter, reports, json, out } };
}

/** One finding per line, in the same shape `validate` prints. */
function findingsText(findings: Finding[]): string {
  return findings.map((finding) => formatFinding(finding)).join("");
}

function formatFinding(finding: Finding): string {
  const location = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
  return `${location} ${finding.code} ${finding.message}\n`;
}

/** One discovery problem per line; a location is repo-relative like findings. */
function discoveryErrorsText(errors: DiscoveryError[]): string {
  return errors
    .map((error) => {
      const location = error.line === undefined ? error.file : `${error.file}:${error.line}`;
      return `${location} ${error.message}\n`;
    })
    .join("");
}

/**
 * Write the selected representation: a machine artifact (`{ checks }`) whenever
 * one is requested with `--json` or `--out`, and one line per check only for the
 * plain human invocation. `--out` writes the artifact to a file through the same
 * `writeOut` boundary; without it the text is printed.
 */
function emit(human: string, json: string, options: Options, io: CliIo): void {
  writeOut(options.out, options.json || options.out !== null ? json : human, io);
}
