/**
 * Align a file-less report with the checks discovery found.
 *
 * A report carries no check id and no file, so `runtimeId` is the only identity
 * available. Each result is consumed **at most once**: two checks in different
 * files may share a `runtimeId` (R35), and one result must never satisfy both —
 * a passing duplicate would otherwise hide the failing check. A check with no
 * remaining result is `not-run`, never green; results that match no check are
 * ignored, exactly as in `verdict`'s artifact alignment (R54).
 */
import type { CheckResult } from "./api.js";

export function alignReportResults(
  checks: readonly { runtimeId: string }[],
  results: readonly CheckResult[],
): CheckResult[] {
  const consumed = new Set<number>();
  return checks.map((check) => {
    const index = results.findIndex(
      (result, candidate) => !consumed.has(candidate) && result.runtimeId === check.runtimeId,
    );
    const matched = index === -1 ? undefined : results[index];
    if (matched === undefined) return { runtimeId: check.runtimeId, outcome: "not-run" };
    consumed.add(index);
    return matched;
  });
}
