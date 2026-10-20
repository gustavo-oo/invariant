import { describe, expect, it } from "vitest";
import { findAdapter } from "../../src/adapter/registry.js";
import { mapVitestJson, readReports } from "../../src/adapter/vitest/report.js";
import { runChecks } from "../../src/adapter/vitest/run.js";
import { makeTmpRepo } from "../helpers/fixture.js";
import { makeVitestRepo } from "../helpers/vitest-repo.js";

it("classifies pass, fail and retried-pass(flaky) from the reporter payload", () => {
  expect(
    mapVitestJson({
      testResults: [
        {
          name: "src/a.test.ts",
          assertionResults: [
            { fullName: "sales > rejects insufficient stock", status: "passed", retryCount: 0 },
            {
              fullName: "sales > blocks negative quantity",
              status: "failed",
              retryCount: 0,
              failureMessages: ["expected 409 to be 200"],
            },
            { fullName: "sales > is idempotent", status: "passed", retryCount: 2 },
          ],
        },
      ],
    }),
  ).toEqual([
    { runtimeId: "sales > rejects insufficient stock", outcome: "pass" },
    { runtimeId: "sales > blocks negative quantity", outcome: "fail", message: "expected 409 to be 200" },
    { runtimeId: "sales > is idempotent", outcome: "flaky" },
  ]);
});

it("marks a declared check absent from the report as not-run", async () => {
  const root = await makeVitestRepo({
    "src/sale.test.ts": `import { test } from "vitest";\n// @check sales.a\n// @rule SALES-004\ntest("a", () => {});\n// @check sales.b\n// @rule SALES-004\ntest.skip("b", () => {});\n`,
  });
  const results = await runChecks(
    [
      {
        checkId: "sales.a",
        rules: ["SALES-004"],
        flows: [],
        testName: "a",
        file: "src/sale.test.ts",
        line: 4,
        frameworkId: "vitest",
        runtimeId: "a",
      },
      {
        checkId: "sales.b",
        rules: ["SALES-004"],
        flows: [],
        testName: "b",
        file: "src/sale.test.ts",
        line: 7,
        frameworkId: "vitest",
        runtimeId: "b",
      },
      {
        checkId: "sales.c",
        rules: ["SALES-004"],
        flows: [],
        testName: "c",
        file: "src/nothing.test.ts",
        line: 1,
        frameworkId: "vitest",
        runtimeId: "c",
      },
    ],
    { root },
  );
  expect(results.map((r) => [r.runtimeId, r.outcome])).toEqual([
    ["a", "pass"],
    ["b", "not-run"],
    ["c", "not-run"],
  ]);
});

it("pins the runtimeId separator against a real nested run", async () => {
  const root = await makeVitestRepo({
    "package.json": "{}",
    "src/n.test.ts": `import { describe, expect, test } from "vitest";\ndescribe("sales", () => {\n  describe("stock", () => {\n    // @check sales.rejects\n    // @rule SALES-004\n    test("rejects", () => { expect(1).toBe(1); });\n  });\n});\n`,
  });
  const [check] = (await findAdapter("vitest")!.discover(root)).checks;
  const results = await runChecks([check!], { root });
  expect(results).toEqual([{ runtimeId: check!.runtimeId, outcome: "pass" }]);
});

it("returns no results and does not spawn when there is nothing to run", async () => {
  expect(await runChecks([], { root: "/does/not/exist" })).toEqual([]);
});

it("reads the report even when a failing test makes vitest exit non-zero", async () => {
  const root = await makeVitestRepo({
    "package.json": "{}",
    "src/f.test.ts": [
      'import { expect, test } from "vitest";',
      "// @check sales.fails",
      "// @rule SALES-004",
      'test("fails", () => { expect(1).toBe(2); });',
      "",
    ].join("\n"),
  });
  const [check] = (await findAdapter("vitest")!.discover(root)).checks;
  const [result] = await runChecks([check!], { root });
  expect(result?.runtimeId).toBe(check!.runtimeId);
  expect(result?.outcome).toBe("fail");
  expect(result?.message).toContain("expected 1 to be 2");
});

it("refuses to run without the project's own vitest install", async () => {
  const root = await makeTmpRepo({ "src/x.test.ts": "" });
  await expect(
    runChecks(
      [
        {
          checkId: "sales.x",
          rules: ["SALES-004"],
          flows: [],
          testName: "x",
          file: "src/x.test.ts",
          line: 1,
          frameworkId: "vitest",
          runtimeId: "x",
        },
      ],
      { root },
    ),
  ).rejects.toThrow(/node_modules[/\\]vitest/);
});

it("includes the child's stderr when no readable report was produced", async () => {
  const root = await makeVitestRepo({
    "package.json": "{}",
    "vitest.config.ts": 'throw new Error("config exploded");\n',
    "src/x.test.ts": 'import { test } from "vitest";\ntest("x", () => {});\n',
  });
  await expect(
    runChecks(
      [
        {
          checkId: "sales.x",
          rules: ["SALES-004"],
          flows: [],
          testName: "x",
          file: "src/x.test.ts",
          line: 2,
          frameworkId: "vitest",
          runtimeId: "x",
        },
      ],
      { root },
    ),
  ).rejects.toThrow(/config exploded/);
});

it("evaluates presence per check file instead of one global runtimeId set", async () => {
  const root = await makeVitestRepo({
    "package.json": "{}",
    "src/a.test.ts": [
      'import { expect, test } from "vitest";',
      "// @check sales.a",
      "// @rule SALES-004",
      'test("same", () => { expect(1).toBe(1); });',
      "",
    ].join("\n"),
    // This file fails to load, so Vitest reports it with zero assertions. Its
    // same-named test must not inherit a.test.ts's pass.
    "src/b.test.ts": [
      'import { test } from "vitest";',
      'throw new Error("b cannot load");',
      "// @check sales.b",
      "// @rule SALES-004",
      'test("same", () => {});',
      "",
    ].join("\n"),
  });
  const { checks, errors } = await findAdapter("vitest")!.discover(root);
  expect(errors).toEqual([]);
  const results = await runChecks(checks, { root });
  expect(results.map((result) => [result.runtimeId, result.outcome])).toEqual([
    ["same", "pass"],
    ["same", "not-run"],
  ]);
});

describe("reporter mapping details", () => {
  it("collapses duplicate names to the most severe outcome and keeps its message", () => {
    expect(
      mapVitestJson({
        testResults: [
          {
            assertionResults: [
              { fullName: "dup", status: "passed" },
              { fullName: "dup", status: "failed", failureMessages: ["boom"] },
              { fullName: "dup", status: "skipped" },
            ],
          },
        ],
      }),
    ).toEqual([{ runtimeId: "dup", outcome: "fail", message: "boom" }]);
  });

  it("never throws on a malformed payload and never greens an unknown status", () => {
    expect(mapVitestJson(null)).toEqual([]);
    expect(mapVitestJson({ testResults: "nope" })).toEqual([]);
    expect(
      mapVitestJson({
        testResults: [
          null,
          { assertionResults: "nope" },
          { assertionResults: [{ fullName: 42, status: "passed" }, null] },
        ],
      }),
    ).toEqual([]);
    expect(
      mapVitestJson({ testResults: [{ assertionResults: [{ fullName: "unknown", status: "mystery" }] }] }),
    ).toEqual([{ runtimeId: "unknown", outcome: "not-run" }]);
  });

  it("reads the first usable report and returns null when none is usable", async () => {
    const root = await makeTmpRepo({
      "bad.json": "{not json",
      "good.json": JSON.stringify({
        testResults: [
          { assertionResults: [{ fullName: "sales > a", status: "failed", failureMessages: ["boom"] }] },
        ],
      }),
    });
    expect(await readReports(["missing.json", "bad.json", "good.json"], root)).toEqual([
      { runtimeId: "sales > a", outcome: "fail", message: "boom" },
    ]);
    expect(await readReports(["missing.json", "bad.json"], root)).toBeNull();
  });
});
