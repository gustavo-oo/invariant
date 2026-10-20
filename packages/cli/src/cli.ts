#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { validate } from "./commands/validate.js";
import { EXIT, type ExitCode } from "./exit.js";
import { defaultIo, type CliIo } from "./output.js";

/** The command surface, as frozen in the implementation plan. */
const USAGE = `invariant - verify the rules declared in rules/** against tagged tests

Usage:
invariant validate  [--root <dir>] [--base <ref>] [--event <path>] [--json] [--out <file>]
invariant run       [--root <dir>] [--adapter <id>] [--reports <file>]... [--json] [--out <file>]
invariant negative  [--root <dir>] [--json] [--out <file>]
invariant verdict   --inputs <dir> [--job-status <job>=<result>]... [--doctor-result <file>]
                    [--repo <owner/name>] [--run-id <id>] [--base <ref>] [--head <sha>]
                    [--out <file>] [--comment <file>] [--json]
invariant verify    [--root <dir>] [--adapter <id>] [--base <ref>] [--head <sha>] [--event <path>]
                    [--doctor-result <file>] [--repo <owner/name>] [--run-id <id>]
                    [--out <file>] [--comment <file>] [--json]
invariant doctor    [--root <dir>] [--record] [--strict] [--check <name>] [--json] [--out <file>]
invariant init      [dir] --owner <@handle> [--adapter <id>] [--cli-setup <cmd>] [--invariant-cmd <cmd>]

Options:
  -h, --help     Print this usage.
      --version  Print the version.

Exit codes:
  0  Every enforced rule and flow is green.
  1  A rule or flow is not green.
  2  Registry invalid, adapter failed, integrity broken, or the verifier could not run.
`;

type Command = (argv: string[], io: CliIo) => Promise<ExitCode>;

/**
 * The dispatch table. Each command module is registered by the task that
 * implements it; a name with no entry is an unknown subcommand.
 */
const COMMANDS: Record<string, Command> = {
  validate,
};

export async function runCli(argv: string[], io: CliIo = defaultIo()): Promise<ExitCode> {
  const [name, ...rest] = argv;

  if (name === "--version") {
    io.stdout(`invariant ${await packageVersion()}\n`);
    return EXIT.GREEN;
  }

  if (name === "--help" || name === "-h") {
    io.stdout(USAGE);
    return EXIT.GREEN;
  }

  const command = name === undefined ? undefined : COMMANDS[name];
  if (command !== undefined) {
    // A command failure is "the verifier could not run" (exit 2), never a
    // product verdict (exit 1). The error text reaches stderr; it is not
    // swallowed. This is the single guard every command inherits.
    try {
      return await command(rest, io);
    } catch (cause) {
      io.stderr(`invariant: ${errorMessage(cause)}\n`);
      return EXIT.GATE_BROKEN;
    }
  }

  io.stderr(`unknown subcommand: ${name ?? ""}\n`);
  io.stderr(USAGE);
  return EXIT.GATE_BROKEN;
}

/**
 * The version lives in `packages/cli/package.json`, which sits next to `src/` and
 * next to the built `dist/`, so resolving it against this module's own URL works
 * both before and after the build.
 */
async function packageVersion(): Promise<string> {
  const url = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(await readFile(url, "utf8")) as { version?: string };
  if (typeof pkg.version !== "string") {
    throw new Error(`invariant: no "version" field in ${url.pathname}`);
  }
  return pkg.version;
}

/** The message of a thrown value, for the command-dispatch failure line. */
function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// Entry point: this module is also the `invariant` bin, so run when invoked as a
// program. The guard keeps importing it (as the tests do) side-effect free, and
// compares real paths because npm installs a bin as a symlink to this file.
if (isEntryPoint()) {
  process.exitCode = await runCli(process.argv.slice(2));
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
