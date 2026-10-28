/**
 * `invariant validate` — load the configuration and the registry, run spec §5
 * validation, reconcile the registry against the tagged tests (spec §8 stage 3)
 * and, when asked for a base ref, check immutability of the protected paths
 * (stage 4, spec §12).
 *
 * Earlier stages stop the world: a config, registry or integrity finding is a
 * gate error (exit 2) with no verdicts, and immutability never runs against a
 * registry that is already broken. Only a clean registry reaches the diff.
 *
 * The diff runs only when `--base` is supplied. Without it the command has no
 * base to compare against, so it must not claim to have checked immutability —
 * and must not shell out to git.
 *
 * Exit codes separate the two kinds of failure (R56): a protected path changed
 * in a pull request without the rule-change label is a *product* verdict
 * (exit 1, spec §12), while config/registry/integrity findings — and a diff
 * that could not be computed at all — are gate errors (exit 2). Product
 * findings print to stdout, like every other product verdict; gate findings
 * print to stderr, so a pipeline can separate "red" from "broken".
 */
import path from "node:path";
import { readEvent, type CiContext } from "../ci/event.js";
import { loadConfig } from "../config/load.js";
import type { Config } from "../config/model.js";
import { EXIT, type ExitCode } from "../exit.js";
import { immutabilityFinding } from "../immutability/diff.js";
import { stringifyJson, writeOut, type CliIo } from "../output.js";
import { reconcile } from "../registry/integrity.js";
import { loadRegistry } from "../registry/load.js";
import { validateRegistry, type Finding } from "../registry/validate.js";
import { createChangedFilesProvider } from "../seams/changed-files.js";
import { createDiscoverySource } from "../seams/discovery-source.js";

const HELP = `invariant validate - check rules/** and reconcile it with tagged tests

Usage:
  invariant validate [--root <dir>] [--base <ref>] [--event <path>] [--json] [--out <file>]

Options:
      --root <dir>    Repository root (default: the current directory).
      --base <ref>    Compare <ref>...HEAD and fail (exit 1) when a protected
                      path changed without the rule-change label.
      --event <path>  GitHub event JSON supplying the pull request labels and
                      head sha (default: $GITHUB_EVENT_PATH). Ignored unless
                      --base is also given.
      --json          Emit {"findings": Finding[]} instead of one line per finding.
      --out <file>    Write the output to a file instead of printing it.
  -h, --help          Print this help.

Integrity:
  A valid registry is reconciled against the tagged tests: a rule whose check no
  test implements, a tagged check no rule or flow declares, a duplicate tag, an
  id that does not match exactly, an unreachable flow reference or a discovery
  error is an integrity failure, not a rule verdict.

Immutability:
  With --base, rules/**, .invariant/**, .github/workflows/invariant.yml and
  .github/CODEOWNERS must not change in a pull request that lacks the
  "invariant:rule-change" label.

Exit codes:
  0  The registry is valid, reconciles with the discovered tests, and no
     protected path changed outside the flagged path.
  1  A protected path changed in a pull request without the rule-change label.
  2  The registry (or the configuration) is invalid, integrity is broken, or the
     diff could not be computed.
`;

interface Options {
  root: string;
  json: boolean;
  out: string | null;
  base: string | null;
  event: string | null;
}

/**
 * The immutability codes that are product verdicts. Everything else in the
 * `immutability.` namespace — currently only `immutability.diff_unavailable` —
 * means the check could not run, which is a gate error (2), never a red (1).
 */
const PRODUCT_IMMUTABILITY_CODES = new Set(["immutability.protected_path_changed"]);

export async function validate(argv: string[], io: CliIo): Promise<ExitCode> {
  const parsed = parseArgs(argv, io);
  if (parsed.kind === "exit") return parsed.code;
  const options = parsed.options;

  const { config, findings: configFindings } = await loadConfig(options.root);
  const { registry, findings: registryFindings } = await loadRegistry(options.root);
  const findings = [...configFindings, ...registryFindings, ...validateRegistry(registry, { cwd: options.root, config })];

  // Stage 3 runs only against a §5-valid registry (R37): an invalid registry is
  // already a gate error, and discovery must not cost anything or muddy it.
  if (findings.length === 0) {
    findings.push(...reconcile(registry, await createDiscoverySource(config).discover(options.root)));
  }

  // Stage 4, only over a registry that already passed stages 1–3.
  if (findings.length === 0) {
    const context = await readEvent(options.event ?? undefined);
    if (options.base !== null) {
      findings.push(...(await immutabilityFindings(options.base, context, config, options.root)));
    }
  }

  if (findings.length > 0) {
    const code = exitFor(findings);
    // `--json` and `--out` already select their own sink; the human text of a
    // product verdict (exit 1) goes to stdout with the other results.
    emit(findingsText(findings), stringifyJson({ findings }), options, io, code === EXIT.PRODUCT_BROKEN ? "stdout" : "stderr");
    return code;
  }

  const enforced = registry.rules.filter((rule) => rule.status === "enforced").length;
  const summary = `${enforced} enforced rule${enforced === 1 ? "" : "s"}\n`;
  emit(summary, stringifyJson({ findings: [] }), options, io, "stdout");
  return EXIT.GREEN;
}

/**
 * Diff `base...head` and classify the result. A diff that cannot be computed is
 * its own finding (`immutability.diff_unavailable`, exit 2): the verifier must
 * never let an unreadable diff pass as "nothing changed" (SELF-003). The base
 * ref stands in for `file`, which a repository-wide failure does not have.
 */
async function immutabilityFindings(base: string, context: CiContext, config: Config, root: string): Promise<Finding[]> {
  try {
    const diff = await createChangedFilesProvider().changedFiles(root, base, context.head ?? "HEAD");
    const result = immutabilityFinding({
      changed: diff.files,
      config,
      context,
      protectedPaths: config.protectedPaths,
    });
    return result.finding === null ? [] : [result.finding];
  } catch (cause) {
    return [
      {
        code: "immutability.diff_unavailable",
        message: oneLine(cause instanceof Error ? cause.message : String(cause)),
        file: base,
      },
    ];
  }
}

/**
 * Findings print one per line, so git's multi-line stderr is folded onto one.
 * The gate still fails; only the presentation is flattened.
 */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

/** Exit 2 when anything but a product-level immutability finding is present. */
function exitFor(findings: Finding[]): ExitCode {
  return findings.every((finding) => PRODUCT_IMMUTABILITY_CODES.has(finding.code)) ? EXIT.PRODUCT_BROKEN : EXIT.GATE_BROKEN;
}

function parseArgs(argv: string[], io: CliIo): { kind: "ok"; options: Options } | { kind: "exit"; code: ExitCode } {
  let root = io.cwd;
  let json = false;
  let out: string | null = null;
  let base: string | null = null;
  let event: string | null = null;

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
        else if (arg === "--base") base = value;
        // An explicit event path is cwd-relative like every other CLI path;
        // `GITHUB_EVENT_PATH` (used when this is null) is already absolute.
        else event = path.resolve(io.cwd, value);
        break;
      }
      default:
        io.stderr(`invariant validate: unknown argument ${arg}\n`);
        return { kind: "exit", code: EXIT.GATE_BROKEN };
    }
  }

  return { kind: "ok", options: { root, json, out, base, event } };
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
 * text. `--out` redirects it to a file. Without it the caller's sink decides:
 * product findings and the success summary go to stdout, gate findings to
 * stderr.
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
