import path from "node:path";
import { readText } from "../../fsutil.js";
import type { CheckResult } from "../api.js";

/**
 * Order used when two assertions claim the same `runtimeId`: a report must never
 * let a passing duplicate hide a failing one.
 */
const SEVERITY: Record<CheckResult["outcome"], number> = {
  pass: 0,
  "not-run": 1,
  flaky: 2,
  fail: 3,
};

/** Vitest's JSON statuses. Anything unrecognised maps to `not-run`, never green. */
const STATUS: Record<string, CheckResult["outcome"]> = {
  passed: "pass",
  failed: "fail",
  pending: "not-run",
  skipped: "not-run",
  todo: "not-run",
  disabled: "not-run",
};

/**
 * Map a Vitest JSON reporter payload to check results.
 *
 * Verified against Vitest 3.2.7 (see the commit message): the reporter emits
 * `testResults[].assertionResults[]` with `fullName`, `ancestorTitles`, `title`,
 * `status` and `failureMessages`. Two observed details shape this mapping:
 * `fullName` joins titles with a single space (`"sales stock rejects"`), while
 * discovery pins `runtimeId` as `[...suites, title].join(" > ")`; and the
 * payload carries no `retryCount` at all. So the id is rebuilt from
 * `ancestorTitles` + `title` (falling back to `fullName`), and `retryCount` is
 * read only when a reporter supplies it.
 *
 * Malformed input is tolerated: a missing/non-array `testResults`, a
 * missing/non-array `assertionResults`, or an entry without a string `fullName`
 * is skipped rather than allowed to abort the whole report.
 */
export function mapVitestJson(json: unknown): CheckResult[] {
  if (!isRecord(json) || !Array.isArray(json.testResults)) return [];

  const results = new Map<string, CheckResult>();
  for (const file of json.testResults) {
    if (!isRecord(file) || !Array.isArray(file.assertionResults)) continue;
    for (const assertion of file.assertionResults) {
      const result = toResult(assertion);
      if (result === undefined) continue;
      const previous = results.get(result.runtimeId);
      // `Map.set` keeps the first insertion position, so report order is stable
      // even when a later, more severe duplicate replaces the earlier result.
      if (previous === undefined || SEVERITY[result.outcome] > SEVERITY[previous.outcome]) {
        results.set(result.runtimeId, result);
      }
    }
  }
  return [...results.values()];
}

/**
 * Read the first report that exists and parses. A missing file, unreadable file
 * or malformed JSON is "no report here", never an exception: the caller falls
 * back to running the suite (spec §6, "read before re-run"). Only Vitest JSON is
 * understood; JUnit is out of scope (PEND-11).
 */
export async function readReports(paths: string[], root: string): Promise<CheckResult[] | null> {
  for (const candidate of paths) {
    const file = path.isAbsolute(candidate) ? candidate : path.join(root, candidate);
    try {
      return mapVitestJson(JSON.parse(await readText(file)) as unknown);
    } catch {
      continue;
    }
  }
  return null;
}

function toResult(assertion: unknown): CheckResult | undefined {
  if (!isRecord(assertion)) return undefined;
  const fullName = assertion.fullName;
  if (typeof fullName !== "string") return undefined;

  const outcome = outcomeOf(assertion);
  const result: CheckResult = { runtimeId: runtimeIdOf(assertion, fullName), outcome };
  if (outcome === "fail") {
    const message = messageOf(assertion.failureMessages);
    if (message !== undefined) result.message = message;
  }
  return result;
}

/**
 * Rebuild discovery's `" > "`-joined id from the structured titles. `fullName`
 * is the presence gate (an entry without one is not a test result) and the
 * fallback when a reporter omits the structured fields.
 */
function runtimeIdOf(assertion: Record<string, unknown>, fullName: string): string {
  const suites = assertion.ancestorTitles;
  const title = assertion.title;
  if (
    Array.isArray(suites) &&
    suites.every((suite) => typeof suite === "string") &&
    typeof title === "string"
  ) {
    return [...suites, title].join(" > ");
  }
  return fullName;
}

function outcomeOf(assertion: Record<string, unknown>): CheckResult["outcome"] {
  const status = assertion.status;
  if (typeof status !== "string") return "not-run";
  const outcome = STATUS[status] ?? "not-run";
  const retryCount = assertion.retryCount;
  // A pass recorded after a retry is visible flakiness, not green.
  if (outcome === "pass" && typeof retryCount === "number" && retryCount > 0) return "flaky";
  return outcome;
}

/** `failureMessages` joined by newlines; a single message is unchanged. */
function messageOf(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const messages = value.filter((message): message is string => typeof message === "string");
  return messages.length === 0 ? undefined : messages.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
