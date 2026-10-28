import { describe, expect, it } from "vitest";
import { alignReportResults } from "../../src/adapter/align.js";

describe("alignReportResults", () => {
  it("consumes each report result at most once when runtime ids collide (R35)", () => {
    const checks = [{ runtimeId: "sales > is idempotent" }, { runtimeId: "sales > is idempotent" }];
    const results = [
      { runtimeId: "sales > is idempotent", outcome: "pass" as const },
      { runtimeId: "sales > is idempotent", outcome: "fail" as const },
    ];

    expect(alignReportResults(checks, results).map((result) => result.outcome)).toEqual([
      "pass",
      "fail",
    ]);
  });

  it("never lets one result green a second check with the same runtime id", () => {
    const checks = [{ runtimeId: "sales > is idempotent" }, { runtimeId: "sales > is idempotent" }];
    const results = [{ runtimeId: "sales > is idempotent", outcome: "pass" as const }];

    expect(alignReportResults(checks, results).map((result) => result.outcome)).toEqual([
      "pass",
      "not-run",
    ]);
  });

  it("fills an unmatched check with not-run and ignores an unattributable result", () => {
    const checks = [{ runtimeId: "sales > is idempotent" }, { runtimeId: "sales > rejects" }];
    const results = [
      { runtimeId: "sales > is idempotent", outcome: "pass" as const },
      { runtimeId: "unrelated > test", outcome: "fail" as const },
    ];

    expect(alignReportResults(checks, results)).toEqual([
      { runtimeId: "sales > is idempotent", outcome: "pass" },
      { runtimeId: "sales > rejects", outcome: "not-run" },
    ]);
  });
});
