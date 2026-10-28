/**
 * `invariant negative` — spec §8 stage 6, executed.
 *
 * The command discovers the checks, reconciles them with the registry, validates
 * every enforced check's sabotage declaration, and then runs the negative
 * control: one isolated sandbox per check, the declared seam module replaced by
 * the sabotage, the check executed, the failure classified. A rule is proven
 * only by an `applied` + `assertion` outcome; a no-op, harness error or timeout
 * is a product red (exit 1); an unexecutable stage is a gate error (exit 2).
 *
 * The machine artifact is `{declared, executed, outcomes, findings}` so
 * `verdict` can roll the same facts up without re-running anything. The human
 * form is one summary line, the declared count, then one line per finding.
 */
import path from "node:path";
import type { Adapter } from "../adapter/api.js";
import { findAdapter } from "../adapter/registry.js";
import { loadConfig } from "../config/load.js";
import { EXIT, type ExitCode } from "../exit.js";
import { checkDeclared } from "../negative/declared.js";
import { runNegativeControl } from "../negative/execute.js";
import { stringifyJson, writeOut, type CliIo } from "../output.js";
import { reconcile } from "../registry/integrity.js";
import { loadRegistry } from "../registry/load.js";
import type { Finding, Registry } from "../registry/model.js";
import { validateRegistry } from "../registry/validate.js";
import { createDiscoverySource } from "../seams/discovery-source.js";
import { isProof } from "../verdict/proof.js";
import type { SabotageOutcome } from "../verdict/types.js";

const EXECUTED = "negative control: executed — ";
const NOT_EXECUTED = "negative control: not executed — ";

const HELP = `invariant negative - execute every enforced rule's declared sabotage

Usage:
  invariant negative [--root <dir>] [--adapter <id>] [--json] [--out <file>]

Options:
      --root <dir>    Repository root (default: the current directory).
      --adapter <id>  Override the configured test-framework adapter.
      --json          Emit {"declared": <n>, "executed": <bool>, "outcomes": {...}, "findings": Finding[]}.
      --out <file>    Write the output to a file instead of printing it.
  -h, --help          Print this help.

The first human line is one of:
  negative control: executed — <proven>/<declared> checks proven able to fail
  negative control: not executed — <reason>

Exit codes:
  0  Every enforced check is an applied, assertion-classified failure under sabotage.
  1  An enforced check is not proven (no-op, harness error or timeout).
  2  The registry/config is invalid, discovery or integrity failed, a declaration
     is incomplete, or the adapter could not run.
`;

interface Options {
  root: string;
  adapters: string[];
  json: boolean;
  out: string | null;
}

interface Artifact {
  declared: number;
  executed: boolean;
  outcomes: Record<string, SabotageOutcome>;
  findings: Finding[];
}

export async function negative(argv: string[], io: CliIo): Promise<ExitCode> {
  const parsed = parseArgs(argv, io);
  if (parsed.kind === "exit") return parsed.code;
  const options = parsed.options;

  const { config, findings: configFindings } = await loadConfig(options.root);
  const ids = options.adapters.length > 0 ? options.adapters : config.adapters;
  const effectiveConfig = { ...config, adapters: ids, adapter: ids[0] ?? config.adapter };
  const { registry, findings: registryFindings } = await loadRegistry(options.root);
  const declared = declaredChecks(registry);

  const invalid = [
    ...configFindings,
    ...registryFindings,
    ...validateRegistry(registry, { cwd: options.root, config: effectiveConfig }),
  ];
  if (invalid.length > 0) {
    return emit(io, options, artifactOf(declared, false, new Map(), invalid), `${NOT_EXECUTED}the registry is invalid`, EXIT.GATE_BROKEN);
  }
  if (declared === 0) {
    return emit(io, options, artifactOf(0, true, new Map(), []), `${EXECUTED}0/0 checks proven able to fail`, EXIT.GREEN);
  }

  const discovery = await createDiscoverySource(effectiveConfig).discover(options.root);
  const integrity = reconcile(registry, discovery);
  if (integrity.length > 0) {
    return emit(
      io,
      options,
      artifactOf(declared, false, new Map(), integrity),
      `${NOT_EXECUTED}discovery or integrity failed`,
      EXIT.GATE_BROKEN,
    );
  }

  const declaration = await checkDeclared(registry, options.root);
  if (declaration.length > 0) {
    return emit(
      io,
      options,
      artifactOf(declared, false, new Map(), declaration),
      `${NOT_EXECUTED}the declared sabotage is incomplete`,
      EXIT.GATE_BROKEN,
    );
  }

  const resolved = ids
    .map((id) => findAdapter(id))
    .filter((found): found is Adapter => found !== undefined);
  if (resolved.length !== ids.length) {
    const unknown = ids.filter((id) => findAdapter(id) === undefined);
    const finding: Finding = {
      code: "negative.adapter_missing",
      message: `unknown adapter: ${unknown.join(", ")}`,
      file: ".invariant/config.yaml",
    };
    return emit(
      io,
      options,
      artifactOf(declared, false, new Map(), [finding]),
      `${NOT_EXECUTED}unknown adapter: ${unknown.join(", ")}`,
      EXIT.GATE_BROKEN,
    );
  }

  const run = await runNegativeControl({
    registry,
    root: options.root,
    adapters: resolved,
    discovered: discovery.checks,
  });
  const artifact = artifactOf(run.declared, run.executed, run.outcomes, [...run.errors, ...run.findings]);

  if (run.errors.length > 0) {
    return emit(
      io,
      options,
      artifact,
      `${NOT_EXECUTED}${run.errors[0]?.message ?? "the negative control could not run"}`,
      EXIT.GATE_BROKEN,
    );
  }

  const proven = [...run.outcomes.values()].filter(isProof).length;
  const code = proven === run.declared && run.findings.length === 0 ? EXIT.GREEN : EXIT.PRODUCT_BROKEN;
  return emit(
    io,
    options,
    artifact,
    `${EXECUTED}${proven}/${run.declared} checks proven able to fail`,
    code,
  );
}

function emit(
  io: CliIo,
  options: Options,
  artifact: Artifact,
  firstLine: string,
  code: ExitCode,
): ExitCode {
  if (options.json) {
    const text = stringifyJson(artifact);
    if (options.out !== null) writeOut(options.out, text, io);
    else io.stdout(text);
    return code;
  }

  const human = `${firstLine}\n${declaredLine(artifact.declared)}${findingsText(artifact.findings)}`;
  if (options.out !== null) {
    writeOut(options.out, human, io);
    return code;
  }

  io.stdout(`${firstLine}\n${declaredLine(artifact.declared)}`);
  if (artifact.findings.length > 0) io.stderr(findingsText(artifact.findings));
  return code;
}

function artifactOf(
  declared: number,
  executed: boolean,
  outcomes: Map<string, SabotageOutcome>,
  findings: Finding[],
): Artifact {
  return { declared, executed, outcomes: sortedOutcomes(outcomes), findings };
}

/** JSON object order is part of the golden; sort by check id. */
function sortedOutcomes(outcomes: Map<string, SabotageOutcome>): Record<string, SabotageOutcome> {
  const result: Record<string, SabotageOutcome> = {};
  for (const key of [...outcomes.keys()].sort(compare)) {
    const value = outcomes.get(key);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function declaredChecks(registry: Registry): number {
  return registry.rules
    .filter((rule) => rule.status === "enforced")
    .reduce((total, rule) => total + rule.checks.length, 0);
}

function declaredLine(declared: number): string {
  return `declared: ${declared} checks\n`;
}

function findingsText(findings: Finding[]): string {
  return findings.map((finding) => formatFinding(finding)).join("");
}

function formatFinding(finding: Finding): string {
  const location = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
  return `${location} ${finding.code} ${finding.message}\n`;
}

function parseArgs(
  argv: string[],
  io: CliIo,
): { kind: "ok"; options: Options } | { kind: "exit"; code: ExitCode } {
  let root = io.cwd;
  const adapters: string[] = [];
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
      case "--out": {
        const value = argv[index + 1];
        if (value === undefined) {
          io.stderr(`invariant negative: ${arg} requires a value\n`);
          return { kind: "exit", code: EXIT.GATE_BROKEN };
        }
        index += 1;
        if (arg === "--root") root = path.resolve(io.cwd, value);
        else if (arg === "--adapter") adapters.push(value);
        else out = value;
        break;
      }
      default:
        io.stderr(`invariant negative: unknown argument ${arg}\n`);
        return { kind: "exit", code: EXIT.GATE_BROKEN };
    }
  }

  return { kind: "ok", options: { root, adapters, json, out } };
}
