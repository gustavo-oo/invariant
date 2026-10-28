/**
 * `invariant init [dir] --owner <@handle>` — write the bootstrap slice.
 *
 * The command runs the forge observation (it may be available interactively),
 * records a G3 baseline until the gate has actually been demonstrated, plans
 * every write, applies it, and prints what it skipped. The class is G3 by
 * design: importing the ruleset and then `doctor --record` is what raises the
 * baseline once the environment is proven (spec §10).
 */
import path from "node:path";
import { loadConfig } from "../config/load.js";
import type { Config } from "../config/model.js";
import type { Baseline } from "../doctor/baseline.js";
import { EXIT, type ExitCode } from "../exit.js";
import { applyInit, planInit } from "../init/plan.js";
import { createForgeProbe, type DoctorObservation } from "../seams/forge-probe.js";
import { TOOL_VERSION } from "../version.js";
import type { CliIo } from "../output.js";

const HELP = `invariant init - write the walking skeleton, config, workflow and ruleset

Usage:
  invariant init [dir] --owner <@handle> [--adapter <id>]
                 [--cli-setup <cmd>] [--invariant-cmd <cmd>]

Options:
      dir                    Repository root (default: the current directory).
      --owner <@handle>      Owner written into the skeleton rules and CODEOWNERS.
      --adapter <id>         Test adapter written into .invariant/config.yaml.
      --cli-setup <cmd>      Command that installs/builds invariant in CI.
      --invariant-cmd <cmd>  Command prefix the workflow uses for invariant.
  -h, --help                 Print this help.

The command never overwrites an existing file or appends the CODEOWNERS block
twice. It exits 0 and prints the class (G3 until the gate is demonstrated).
`;

interface Options {
  root: string;
  owner: string | null;
  adapter: string | null;
  cliSetup: string | null;
  invariantCmd: string | null;
}

export async function init(argv: string[], io: CliIo): Promise<ExitCode> {
  const parsed = parseArgs(argv, io);
  if (parsed.kind === "exit") return parsed.code;
  const options = parsed.options;
  if (options.owner === null) {
    io.stderr("invariant init: --owner <@handle> is required\n");
    return EXIT.GATE_BROKEN;
  }

  const owner = options.owner.startsWith("@") ? options.owner : `@${options.owner}`;
  const { config } = await loadConfig(options.root);
  const observation = await createForgeProbe(config).observe(options.root);
  const baseline = baselineFor(observation, config);
  const plan = await planInit({
    root: options.root,
    owner,
    adapter: options.adapter ?? config.adapter,
    cliSetup:
      options.cliSetup ?? `npm install --no-save --no-fund invariant@${TOOL_VERSION}`,
    invariantCmd: options.invariantCmd ?? "npx --no-install invariant",
    invariantVersion: TOOL_VERSION,
    baseline,
  });

  await applyInit(options.root, plan.writes);

  const written = plan.writes.filter((write) => write.mode !== "skip").length;
  const skipped = plan.writes.filter((write) => write.mode === "skip").length;
  io.stdout(`init: ${written} files written, ${skipped} skipped\n`);
  for (const finding of plan.findings) {
    io.stdout(`${finding.file} ${finding.code} ${finding.message}\n`);
  }
  io.stdout(`class: ${baseline.recorded_class} (procedural)\n`);
  return EXIT.GREEN;
}

function baselineFor(observation: DoctorObservation, config: Config): Baseline {
  return {
    schema_version: 1,
    // Init records G3 until the gate has run and the ruleset has been imported;
    // `doctor --record` is the explicit step that raises it (spec §10).
    recorded_class: "G3",
    expected: {
      required_context: "invariant-verdict",
      required_context_app_id: config.doctor.expectedAppId,
      protected_paths: [...config.protectedPaths],
      bypass_actors: observation.available
        ? observation.protection.bypassActors.map((actor) => ({ ...actor }))
        : [],
    },
  };
}

function parseArgs(
  argv: string[],
  io: CliIo,
): { kind: "ok"; options: Options } | { kind: "exit"; code: ExitCode } {
  let root: string | null = null;
  let owner: string | null = null;
  let adapter: string | null = null;
  let cliSetup: string | null = null;
  let invariantCmd: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) break;
    switch (arg) {
      case "-h":
      case "--help":
        io.stdout(HELP);
        return { kind: "exit", code: EXIT.GREEN };
      case "--owner":
      case "--adapter":
      case "--cli-setup":
      case "--invariant-cmd": {
        const value = argv[index + 1];
        if (value === undefined) {
          io.stderr(`invariant init: ${arg} requires a value\n`);
          return { kind: "exit", code: EXIT.GATE_BROKEN };
        }
        index += 1;
        if (arg === "--owner") owner = value;
        else if (arg === "--adapter") adapter = value;
        else if (arg === "--cli-setup") cliSetup = value;
        else invariantCmd = value;
        break;
      }
      default:
        if (arg.startsWith("-")) {
          io.stderr(`invariant init: unknown argument ${arg}\n`);
          return { kind: "exit", code: EXIT.GATE_BROKEN };
        }
        if (root !== null) {
          io.stderr("invariant init: at most one repository directory is accepted\n");
          return { kind: "exit", code: EXIT.GATE_BROKEN };
        }
        root = path.resolve(io.cwd, arg);
        break;
    }
  }

  return {
    kind: "ok",
    options: { root: root ?? io.cwd, owner, adapter, cliSetup, invariantCmd },
  };
}
