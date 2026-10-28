/**
 * `invariant negative` — spec §8 stage 6 in declaration form.
 *
 * This delivery executes no sabotage (PEND-1), so the command's first line says
 * so and the artifact records `executed: false`. What it can check is the
 * declaration: every enforced rule's check names a sabotage file, the file
 * exists, declares exactly one `@seam-alias`, and that alias names an existing
 * file in the repo other than the sabotage itself.
 *
 * The machine artifact is `{declared, executed, findings}` because `verdict`
 * consumes that shape from `negative-result.json` (R50). The human form is the
 * notice, the count, then one line per finding. An invalid registry is a gate
 * error before any declaration is examined, just as in `run`/`validate`.
 */
import path from "node:path";
import { loadConfig } from "../config/load.js";
import { EXIT, type ExitCode } from "../exit.js";
import { checkDeclared } from "../negative/declared.js";
import { stringifyJson, writeOut, type CliIo } from "../output.js";
import { loadRegistry } from "../registry/load.js";
import type { Finding, Registry } from "../registry/model.js";
import { validateRegistry } from "../registry/validate.js";

const NOTICE =
  "negative control: declared-only — seam sabotage is NOT executed in this delivery (Phase 2)";

const HELP = `invariant negative - validate every enforced rule's declared sabotage

Usage:
  invariant negative [--root <dir>] [--json] [--out <file>]

Options:
      --root <dir>    Repository root (default: the current directory).
      --json          Emit {"declared": <n>, "executed": false, "findings": Finding[]}.
      --out <file>    Write the output to a file instead of printing it.
  -h, --help          Print this help.

The first human line is always:
  negative control: declared-only — seam sabotage is NOT executed in this delivery (Phase 2)

Exit codes:
  0  Every enforced check has a complete sabotage declaration.
  2  The registry is invalid or a declaration is incomplete.
`;

interface Options {
  root: string;
  json: boolean;
  out: string | null;
}

export async function negative(argv: string[], io: CliIo): Promise<ExitCode> {
  const parsed = parseArgs(argv, io);
  if (parsed.kind === "exit") return parsed.code;
  const options = parsed.options;

  const { config, findings: configFindings } = await loadConfig(options.root);
  const { registry, findings: registryFindings } = await loadRegistry(options.root);
  const declared = declaredChecks(registry);

  const invalid = [
    ...configFindings,
    ...registryFindings,
    ...validateRegistry(registry, { cwd: options.root, config }),
  ];
  const findings = invalid.length > 0 ? invalid : await checkDeclared(registry, options.root);

  const artifact = { declared, executed: false, findings };
  if (options.json) {
    const text = stringifyJson(artifact);
    if (options.out !== null) writeOut(options.out, text, io);
    else io.stdout(text);
  } else {
    const human = `${NOTICE}\n${declaredLine(declared)}${findingsText(findings)}`;
    if (options.out !== null) writeOut(options.out, human, io);
    else {
      io.stdout(`${NOTICE}\n${declaredLine(declared)}`);
      if (findings.length > 0) io.stderr(findingsText(findings));
    }
  }

  return findings.length > 0 ? EXIT.GATE_BROKEN : EXIT.GREEN;
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
      case "--out": {
        const value = argv[index + 1];
        if (value === undefined) {
          io.stderr(`invariant negative: ${arg} requires a value\n`);
          return { kind: "exit", code: EXIT.GATE_BROKEN };
        }
        index += 1;
        if (arg === "--root") root = path.resolve(io.cwd, value);
        else out = value;
        break;
      }
      default:
        io.stderr(`invariant negative: unknown argument ${arg}\n`);
        return { kind: "exit", code: EXIT.GATE_BROKEN };
    }
  }

  return { kind: "ok", options: { root, json, out } };
}
