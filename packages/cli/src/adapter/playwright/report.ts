/**
 * Playwright's JSON reporter → `CheckResult[]`.
 *
 * The report has one top-level suite per project (`chromium`, `firefox`, …);
 * the project title is not part of a check's identity. Results are merged by
 * `runtimeId` across projects with the worst status winning: a check is `pass`
 * only when every project passes. Unknown statuses are `not-run`, never green.
 */
import path from "node:path";
import { readText } from "../../fsutil.js";
import type { CheckResult } from "../api.js";
import { readJunitXml } from "../junit/xml.js";

const SEVERITY: Record<CheckResult["outcome"], number> = {
  pass: 0,
  "not-run": 1,
  flaky: 2,
  fail: 3,
};

export function mapPlaywrightJson(json: unknown): CheckResult[] {
  if (!isRecord(json) || !Array.isArray(json.suites)) return [];
  const merged = new Map<string, CheckResult>();

  const add = (result: CheckResult): void => {
    const previous = merged.get(result.runtimeId);
    if (previous === undefined || SEVERITY[result.outcome] >= SEVERITY[previous.outcome]) {
      merged.set(result.runtimeId, result);
    }
  };

  const walk = (suite: unknown, ancestors: string[], top: boolean): void => {
    if (!isRecord(suite)) return;
    const title = typeof suite.title === "string" ? suite.title : "";
    const next = top ? ancestors : [...ancestors, title];

    if (Array.isArray(suite.specs)) {
      for (const spec of suite.specs) {
        if (!isRecord(spec) || typeof spec.title !== "string") continue;
        const runtimeId = [...next, spec.title].join(" > ");
        const outcome = specOutcome(spec);
        const message = specMessage(spec);
        add({
          runtimeId,
          outcome,
          frameworkId: "playwright",
          ...(message === undefined ? {} : { message }),
        });
      }
    }

    if (Array.isArray(suite.suites)) {
      for (const child of suite.suites) walk(child, next, false);
    }
  };

  for (const project of json.suites) walk(project, [], true);
  return [...merged.values()];
}

function specOutcome(spec: Record<string, unknown>): CheckResult["outcome"] {
  const tests = Array.isArray(spec.tests) ? spec.tests : [];
  let outcome: CheckResult["outcome"] | undefined;
  for (const test of tests) {
    if (!isRecord(test) || typeof test.status !== "string") continue;
    const candidate = statusOutcome(test.status);
    if (outcome === undefined || SEVERITY[candidate] > SEVERITY[outcome]) outcome = candidate;
  }
  return outcome ?? "not-run";
}

function statusOutcome(status: string): CheckResult["outcome"] {
  switch (status) {
    case "expected":
      return "pass";
    case "unexpected":
      return "fail";
    case "flaky":
      return "flaky";
    case "skipped":
      return "not-run";
    default:
      return "not-run";
  }
}

function specMessage(spec: Record<string, unknown>): string | undefined {
  const tests = Array.isArray(spec.tests) ? spec.tests : [];
  let message: string | undefined;
  for (const test of tests) {
    if (!isRecord(test) || !Array.isArray(test.results)) continue;
    for (const result of test.results) {
      if (!isRecord(result)) continue;
      const error = isRecord(result.error) ? result.error : undefined;
      if (typeof error?.message === "string") message = error.message;
    }
  }
  return message;
}

export function isPlaywrightReport(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.suites);
}

/** Read the first Playwright JSON or JUnit report; `null` when none parses. */
export async function readPlaywrightReports(
  paths: string[],
  root: string,
): Promise<CheckResult[] | null> {
  for (const candidate of paths) {
    const file = path.isAbsolute(candidate) ? candidate : path.join(root, candidate);
    let text: string;
    try {
      text = await readText(file);
    } catch {
      continue;
    }

    try {
      const json: unknown = JSON.parse(text);
      if (isPlaywrightReport(json)) return mapPlaywrightJson(json);
    } catch {
      // Not JSON; try JUnit below.
    }

    const junit = readJunitXml(text);
    if (junit !== null) return junit.map((result) => ({ ...result, frameworkId: "playwright" }));
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
