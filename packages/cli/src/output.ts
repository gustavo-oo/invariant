import { writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The injected process boundary. Every byte the CLI emits goes through
 * `stdout`/`stderr`, and every path it reads is resolved against `cwd`, so a
 * test can run the whole CLI hermetically.
 */
export interface CliIo {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** The real process boundary, used when `runCli` is called without an `io`. */
export function defaultIo(): CliIo {
  return {
    cwd: process.cwd(),
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  };
}

/**
 * Canonical rendering of a JSON artefact: pretty-printed and newline-terminated
 * so it ends a file cleanly and diffs well. Carries no clock.
 */
export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/**
 * Write `text` to `target`: `null` means the injected stdout sink, anything else
 * is a file path resolved against `io.cwd`.
 */
export function writeOut(target: string | null, text: string, io: CliIo = defaultIo()): void {
  if (target === null) {
    io.stdout(text);
    return;
  }
  writeFileSync(path.resolve(io.cwd, target), text, "utf8");
}
