/**
 * `invariant validate` — the first real command: load the configuration and the
 * registry, run spec §5 validation, and stop the world (exit 2, no rule
 * verdicts) when the registry is invalid.
 *
 * `--base` and `--event` are accepted and ignored here: immutability against a
 * base ref is wired in by a later task. They are documented in the help text so
 * nobody assumes this command already enforces it.
 */
import path from "node:path";
import { loadConfig } from "../config/load.js";
import { EXIT, type ExitCode } from "../exit.js";
import { stringifyJson, writeOut, type CliIo } from "../output.js";
import { loadRegistry } from "../registry/load.js";
import { validateRegistry, type Finding } from "../registry/validate.js";

const HELP = `invariant validate - check that rules/** is a valid registry

Usage:
  invariant validate [--root <dir>] [--base <ref>] [--event <path>] [--json] [--out <file>]

Options:
      --root <dir>    Repository root (default: the current directory).
      --base <ref>    Accepted and ignored by validate; immutability is checked
                      by the verify pipeline.
      --event <path>  Accepted and ignored by validate; event handling is part
                      of the verify pipeline.
      --json          Emit {"findings": Finding[]} instead of one line per finding.
      --out <file>    Write the output to a file instead of printing it.
  -h, --help          Print this help.

Exit codes:
  0  The registry is valid.
  2  The registry (or the configuration) is invalid.
`;

interface Options {
  root: string;
  json: boolean;
  out: string | null;
}

export async function validate(argv: string[], io: CliIo): Promise<ExitCode> {
  const parsed = parseArgs(argv, io);
  if (parsed.kind === "exit") return parsed.code;
  const options = parsed.options;

  const { config, findings: configFindings } = await loadConfig(options.root);
  const { registry, findings: registryFindings } = await loadRegistry(options.root);
  const findings = [...configFindings, ...registryFindings, ...validateRegistry(registry, { cwd: options.root, config })];

  if (findings.length > 0) {
    emit(findingsText(findings), stringifyJson({ findings }), options, io, "stderr");
    return EXIT.GATE_BROKEN;
  }

  const enforced = registry.rules.filter((rule) => rule.status === "enforced").length;
  const summary = `${enforced} enforced rule${enforced === 1 ? "" : "s"}\n`;
  emit(summary, stringifyJson({ findings: [] }), options, io, "stdout");
  return EXIT.GREEN;
}

function parseArgs(argv: string[], io: CliIo): { kind: "ok"; options: Options } | { kind: "exit"; code: ExitCode } {
  let root = io.cwd;
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
      case "--out":
      case "--base":
      case "--event": {
        const value = argv[index + 1];
        if (value === undefined) {
          io.stderr(`invariant validate: ${arg} requires a value\n`);
          return { kind: "exit", code: EXIT.GATE_BROKEN };
        }
        index += 1;
        if (arg === "--root") root = path.resolve(io.cwd, value);
        else if (arg === "--out") out = value;
        // --base and --event are accepted and ignored in this task.
        break;
      }
      default:
        io.stderr(`invariant validate: unknown argument ${arg}\n`);
        return { kind: "exit", code: EXIT.GATE_BROKEN };
    }
  }

  return { kind: "ok", options: { root, json, out } };
}

/** One finding per line, with the repo-relative file the loader already recorded. */
function findingsText(findings: Finding[]): string {
  return findings.map((finding) => formatFinding(finding)).join("");
}

function formatFinding(finding: Finding): string {
  const location = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
  return `${location} ${finding.code} ${finding.message}\n`;
}

/**
 * Write the selected representation: JSON when `--json`, otherwise the human
 * text. `--out` redirects it to a file; without it findings go to stderr and
 * the success summary to stdout.
 */
function emit(human: string, json: string, options: Options, io: CliIo, humanSink: "stdout" | "stderr"): void {
  const text = options.json ? json : human;
  if (options.out !== null) {
    writeOut(options.out, text, io);
    return;
  }
  if (options.json) {
    io.stdout(text);
    return;
  }
  if (humanSink === "stderr") io.stderr(human);
  else io.stdout(human);
}
