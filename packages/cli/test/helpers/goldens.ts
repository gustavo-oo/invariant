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
import type { Report } from "../../src/report/shape.js";

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

/**
 * Replace the one volatile field (`tool.version`) so a report can be pinned.
 * The report is otherwise deterministic by construction: no clock, no
 * durations, no hostnames.
 */
export function normalizeReport(value: unknown): Report {
  if (!isReport(value)) {
    throw new Error("normalizeReport: value is not an invariant report");
  }
  return { ...value, tool: { ...value.tool, version: "<version>" } };
}

/**
 * The report-shaped guard `normalizeReport` and `readReport` share. It checks
 * the envelope the wire format promises, never a deep verdict shape: goldens
 * exist to catch a shape change, not to duplicate the type system.
 */
export function isReport(value: unknown): value is Report {
  if (!isRecord(value)) return false;

  const tool = value["tool"];
  const inputs = value["inputs"];
  const guarantee = value["guarantee"];
  const registry = value["registry"];
  const immutability = value["immutability"];

  return (
    value["schema_version"] === 1 &&
    isRecord(tool) &&
    tool["name"] === "invariant" &&
    typeof tool["version"] === "string" &&
    isRecord(inputs) &&
    isRecord(guarantee) &&
    typeof guarantee["class"] === "string" &&
    Array.isArray(guarantee["class_reasons"]) &&
    typeof guarantee["binding"] === "boolean" &&
    typeof guarantee["negative_control"] === "string" &&
    isRecord(guarantee["doctor"]) &&
    isRecord(registry) &&
    Array.isArray(registry["files"]) &&
    isRecord(registry["hashes"]) &&
    isRecord(immutability) &&
    Array.isArray(immutability["protected_paths_changed"]) &&
    Array.isArray(value["integrity"]) &&
    Array.isArray(value["checks"]) &&
    Array.isArray(value["rules"]) &&
    Array.isArray(value["flows"]) &&
    typeof value["exit_code"] === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
