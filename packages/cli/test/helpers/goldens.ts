/**
 * Golden-file assertions for CLI output. A string is written verbatim; any
 * other value is rendered as pretty JSON with a trailing newline, the same
 * `stringifyJson` shape the CLI emits.
 *
 * `UPDATE_GOLDENS=1` rewrites the golden, then compares against what was
 * written, so an update run still proves the assertion path works.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

const GOLDEN_ROOT = fileURLToPath(new URL("../golden/", import.meta.url));

export async function expectGolden(name: string, value: unknown, file: string): Promise<void> {
  const target = path.join(GOLDEN_ROOT, name, file);
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n";

  if (process.env["UPDATE_GOLDENS"] === "1") {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
  }

  const expected = await readFile(target, "utf8");
  expect(text).toBe(expected);
}
