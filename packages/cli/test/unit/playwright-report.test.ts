import { describe, expect, it } from "vitest";
import { discoverTestFile } from "../../src/adapter/vitest/ast.js";
import { mapPlaywrightJson, readPlaywrightReports } from "../../src/adapter/playwright/report.js";
import { makeTmpRepo } from "../helpers/fixture.js";

function report(statuses: Array<"expected" | "unexpected" | "skipped" | "flaky">): unknown {
  return {
    suites: statuses.map((status, index) => ({
      title: index === 0 ? "chromium" : "firefox",
      file: "e2e/checkout.spec.ts",
      suites: [
        {
          title: "checkout",
          specs: [
            {
              title: "completes",
              ok: status === "expected",
              tests: [
                {
                  status,
                  results:
                    status === "unexpected"
                      ? [{ status: "failed", error: { message: "Error: expect(received).toBe(expected)" } }]
                      : [{ status: "passed" }],
                },
              ],
            },
          ],
        },
      ],
    })),
  };
}

describe("mapPlaywrightJson", () => {
  it("skips the project title and maps expected/unexpected", () => {
    expect(mapPlaywrightJson(report(["expected"]))).toEqual([
      { runtimeId: "checkout > completes", outcome: "pass", frameworkId: "playwright" },
    ]);
    expect(mapPlaywrightJson(report(["unexpected"]))).toEqual([
      {
        runtimeId: "checkout > completes",
        outcome: "fail",
        frameworkId: "playwright",
        message: "Error: expect(received).toBe(expected)",
      },
    ]);
  });

  it("merges projects by worst status: one failure fails the check", () => {
    expect(mapPlaywrightJson(report(["expected", "unexpected"]))).toEqual([
      {
        runtimeId: "checkout > completes",
        outcome: "fail",
        frameworkId: "playwright",
        message: "Error: expect(received).toBe(expected)",
      },
    ]);
  });

  it("treats a skipped project as not-run and never as green", () => {
    expect(mapPlaywrightJson(report(["expected", "skipped"]))).toEqual([
      { runtimeId: "checkout > completes", outcome: "not-run", frameworkId: "playwright" },
    ]);
  });

  it("returns an empty list for a non-Playwright payload", () => {
    expect(mapPlaywrightJson({ testResults: [] })).toEqual([]);
  });
});

describe("Playwright discovery", () => {
  it("recognizes test.describe as a suite and hooks as non-tests", () => {
    const text = [
      'import { test } from "@playwright/test";',
      'test.describe("checkout", () => {',
      "  test.beforeEach(() => {});",
      "  // @check checkout.completes",
      "  // @flow checkout",
      '  test("completes", () => {});',
      "});",
    ].join("\n");

    const found = discoverTestFile("e2e/checkout.spec.ts", text, {
      frameworkId: "playwright",
      playwright: true,
    });

    expect(found.errors).toEqual([]);
    expect(found.checks).toEqual([
      {
        checkId: "checkout.completes",
        rules: [],
        flows: [{ flow: "checkout" }],
        testName: "completes",
        file: "e2e/checkout.spec.ts",
        line: 6,
        frameworkId: "playwright",
        runtimeId: "checkout > completes",
      },
    ]);
  });
});

describe("readPlaywrightReports", () => {
  it("reads a Playwright JSON report", async () => {
    const root = await makeTmpRepo({ "e2e/report.json": JSON.stringify(report(["expected"])) });
    expect(await readPlaywrightReports(["e2e/report.json"], root)).toEqual([
      { runtimeId: "checkout > completes", outcome: "pass", frameworkId: "playwright" },
    ]);
  });

  it("returns null when no path is a Playwright report", async () => {
    const root = await makeTmpRepo({ "e2e/report.json": "{}" });
    expect(await readPlaywrightReports(["e2e/report.json"], root)).toBeNull();
  });
});
