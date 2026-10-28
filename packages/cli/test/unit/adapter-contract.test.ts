import { describe, expect, it } from "vitest";
import type { SabotageSpec } from "../../src/adapter/api.js";
import type { DiscoveredCheck } from "../../src/discovery/types.js";
import { stubAdapter } from "../helpers/stub-adapter.js";

const check: DiscoveredCheck = {
  checkId: "sales.a",
  rules: ["SALES-004"],
  flows: [],
  testName: "a",
  file: "a.test.ts",
  line: 1,
  frameworkId: "stub",
  runtimeId: "a",
};

const spec: SabotageSpec = {
  check,
  sabotagePath: ".invariant/sabotages/a.ts",
  seamAlias: "src/a.ts",
  sabotageText: "export const a = 1",
  workdir: "/tmp/x",
  env: {},
};

describe("Adapter contract", () => {
  it("exposes applySabotage and classifyFailure on every adapter", async () => {
    const adapter = stubAdapter({
      discovered: [],
      results: [],
      sabotageOutcomes: new Map([["sales.a", { status: "applied", classification: "assertion" }]]),
    });

    expect(typeof adapter.applySabotage).toBe("function");
    expect(
      adapter.classifyFailure({ runtimeId: "a", outcome: "fail", message: "AssertionError: expected 1 to be 2" }),
    ).toBe("assertion");
    await expect(adapter.applySabotage(spec)).resolves.toEqual({
      status: "applied",
      classification: "assertion",
    });
  });

  it("defaults an unconfigured sabotage to not-executed and an unknown failure to harness", async () => {
    const adapter = stubAdapter({ discovered: [], results: [] });

    await expect(adapter.applySabotage(spec)).resolves.toEqual({ status: "not-executed" });
    expect(adapter.classifyFailure({ runtimeId: "a", outcome: "fail", message: "boom" })).toBe("harness");
  });
});
