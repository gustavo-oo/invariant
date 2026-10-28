/**
 * Failure classification (spec §7). Only an `assertion` failure can become
 * proof; a harness error, a timeout and anything unrecognised are non-proof by
 * construction. The default is deliberately `harness`, never `assertion`.
 */
import type { CheckResult } from "./api.js";

/** Vitest reports an explicit timeout; a killed child is handled by the runner. */
const TIMEOUT = /timed out|TimeoutError|Test timeout of \d+ms exceeded/i;

/** A real `expect` failure. A custom thrown `Error` does not qualify. */
const ASSERTION = /AssertionError|expected .* to (?:be|equal|include|match|throw|have|contain|deeply)/i;

export function classifyFailureMessage(
  outcome: CheckResult["outcome"],
  message?: string,
): "assertion" | "harness" | "timeout" {
  // A pass/flaky sabotaged run is not a failure to classify; the caller turns it
  // into `not-applied`. If it reaches here anyway, fail closed.
  if (outcome === "pass" || outcome === "flaky") return "harness";

  const text = message ?? "";
  if (TIMEOUT.test(text)) return "timeout";
  if (ASSERTION.test(text)) return "assertion";
  return "harness";
}
