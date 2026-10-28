import { describe, expect, it } from "vitest";
import type { SabotageSpec } from "../../src/adapter/api.js";
import { classifyFailureMessage } from "../../src/adapter/failure.js";
import { applyVitestSabotage } from "../../src/adapter/vitest/sabotage.js";
import { makeVitestRepo } from "../helpers/fixture.js";

const SEAM = `export const policy = () => ({ available: () => 1 });\n`;
const TEST = [
  `import { expect, test } from "vitest";`,
  `import { policy } from "../src/stock-policy";`,
  `// @check sales.rejects-insufficient-stock`,
  `// @rule SALES-004`,
  `test("rejects insufficient stock", () => { expect(policy().available()).toBe(1); });`,
].join("\n");

const ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
};
if (process.env.TMPDIR !== undefined) ENV["TMPDIR"] = process.env.TMPDIR;

function spec(
  root: string,
  sabotageText: string,
  overrides: Partial<SabotageSpec> = {},
): SabotageSpec {
  return {
    check: {
      checkId: "sales.rejects-insufficient-stock",
      rules: ["SALES-004"],
      flows: [],
      testName: "rejects insufficient stock",
      file: "tests/sale.test.ts",
      line: 3,
      frameworkId: "vitest",
      runtimeId: "rejects insufficient stock",
    },
    sabotagePath: ".invariant/sabotages/sales/stock.ts",
    seamAlias: "src/stock-policy.ts",
    sabotageText,
    workdir: root,
    env: ENV,
    ...overrides,
  };
}

async function repo(): Promise<string> {
  return await makeVitestRepo({
    "package.json": "{}",
    "tests/sale.test.ts": TEST,
    "src/stock-policy.ts": SEAM,
  });
}

describe("classifyFailureMessage", () => {
  it("counts only an explicit assertion failure as assertion", () => {
    expect(classifyFailureMessage("fail", "AssertionError: expected 2 to be 1")).toBe("assertion");
    expect(classifyFailureMessage("fail", "expected 200 to equal 409")).toBe("assertion");
    expect(classifyFailureMessage("fail", "Test timed out in 1000ms.")).toBe("timeout");
    expect(classifyFailureMessage("fail", "Cannot find module './x'")).toBe("harness");
    expect(classifyFailureMessage("fail", "boom")).toBe("harness");
    expect(classifyFailureMessage("pass", "expected 2 to be 1")).toBe("harness");
  });
});

describe("applyVitestSabotage", () => {
  it("proves an assertion failure produced by a real module replacement", async () => {
    const root = await repo();
    const outcome = await applyVitestSabotage(
      spec(root, "export const policy = () => ({ available: () => Infinity });\n"),
    );
    expect(outcome).toEqual({ status: "applied", classification: "assertion" });
  });

  it("reports a no-op as not-applied", async () => {
    const root = await repo();
    const outcome = await applyVitestSabotage(spec(root, SEAM));
    expect(outcome).toEqual({ status: "not-applied" });
  });

  it("classifies a broken replacement as harness, never proof", async () => {
    const root = await repo();
    const outcome = await applyVitestSabotage(spec(root, "export const policy = () => {"));
    expect(outcome.status).toBe("applied");
    expect(outcome).toMatchObject({ classification: "harness" });
  });

  it("reports a missing seam target as not-applied", async () => {
    const root = await repo();
    const outcome = await applyVitestSabotage(spec(root, SEAM, { seamAlias: "src/missing.ts" }));
    expect(outcome).toEqual({ status: "not-applied" });
  });

  it("never treats a Vitest timeout as proof", async () => {
    const root = await makeVitestRepo({
      "package.json": "{}",
      "tests/sale.test.ts": [
        `import { test } from "vitest";`,
        `import { policy } from "../src/stock-policy";`,
        `// @check sales.rejects-insufficient-stock`,
        `// @rule SALES-004`,
        `test("times out", async () => { void policy(); await new Promise(() => {}); }, 1000);`,
      ].join("\n"),
      "src/stock-policy.ts": SEAM,
    });
    const outcome = await applyVitestSabotage(
      spec(root, "export const policy = () => ({ available: () => Infinity });\n", {
        check: {
          ...spec(root, "").check,
          testName: "times out",
          runtimeId: "times out",
        },
      }),
    );
    expect(outcome.status).toBe("applied");
    // Vitest 3's JSON reporter emits `Error: STACK_TRACE_ERROR` for a timed-out
    // test, losing the "timed out" text. `harness` and `timeout` are both
    // non-proof; only `assertion` would be a false green.
    expect(["harness", "timeout"]).toContain(outcome.classification);
  });
});
