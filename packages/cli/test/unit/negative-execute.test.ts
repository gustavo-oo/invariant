import { describe, expect, it } from "vitest";
import type { DiscoveredCheck } from "../../src/discovery/types.js";
import { runNegativeControl } from "../../src/negative/execute.js";
import { loadRegistry } from "../../src/registry/load.js";
import { makeTmpRepo } from "../helpers/fixture.js";
import { capability } from "../helpers/registry.js";
import { stubAdapter } from "../helpers/stub-adapter.js";

const CHECK_ID = "sales.rejects-insufficient-stock";

function check(frameworkId = "stub"): DiscoveredCheck {
  return {
    checkId: CHECK_ID,
    rules: ["SALES-004"],
    flows: [],
    testName: "rejects insufficient stock",
    file: "src/sale.test.ts",
    line: 1,
    frameworkId,
    runtimeId: "rejects insufficient stock",
  };
}

async function repo(extra: Record<string, string> = {}): Promise<string> {
  return await makeTmpRepo({
    "rules/sales.yaml": capability("SALES-004"),
    ".invariant/sabotages/sales/stock.ts":
      "// @seam-alias src/stock-policy.ts\nexport const policy = () => 1;\n",
    "src/stock-policy.ts": "export const policy = () => 1;\n",
    ...extra,
  });
}

describe("runNegativeControl", () => {
  it("maps every enforced check to an outcome and a non-proof finding", async () => {
    const root = await repo();
    const { registry } = await loadRegistry(root);
    const adapter = stubAdapter({
      discovered: [],
      results: [],
      sabotageOutcomes: new Map([[CHECK_ID, { status: "not-applied" }]]),
    });

    const run = await runNegativeControl({
      registry,
      root,
      adapters: [adapter],
      discovered: [check()],
    });

    expect(run.declared).toBe(1);
    expect(run.executed).toBe(true);
    expect(run.outcomes.get(CHECK_ID)).toEqual({ status: "not-applied" });
    expect(run.findings.map((finding) => finding.code)).toEqual(["negative.sabotage_not_applied"]);
    expect(run.errors).toEqual([]);
  });

  it("does not execute a check that was never discovered", async () => {
    const root = await repo();
    const { registry } = await loadRegistry(root);
    const adapter = stubAdapter({ discovered: [], results: [] });

    const run = await runNegativeControl({ registry, root, adapters: [adapter], discovered: [] });

    expect(run.executed).toBe(false);
    expect(run.errors.map((finding) => finding.code)).toContain("negative.check_not_discovered");
    expect(run.outcomes.get(CHECK_ID)).toEqual({ status: "not-executed" });
  });

  it("refuses a check whose framework has no adapter", async () => {
    const root = await repo();
    const { registry } = await loadRegistry(root);
    const adapter = stubAdapter({ discovered: [], results: [] });

    const run = await runNegativeControl({
      registry,
      root,
      adapters: [adapter],
      discovered: [check("missing-framework")],
    });

    expect(run.executed).toBe(false);
    expect(run.errors.map((finding) => finding.code)).toContain("negative.execution_failed");
  });

  it("refuses a missing sabotage declaration before creating a sandbox", async () => {
    const root = await makeTmpRepo({
      "rules/sales.yaml": capability("SALES-004"),
      "src/stock-policy.ts": "export const policy = () => 1;\n",
    });
    const { registry } = await loadRegistry(root);
    const adapter = stubAdapter({ discovered: [], results: [] });

    const run = await runNegativeControl({
      registry,
      root,
      adapters: [adapter],
      discovered: [check()],
    });

    expect(run.executed).toBe(false);
    expect(run.errors.map((finding) => finding.code)).toContain("negative.sabotage_missing");
  });

  it("refuses an ambiguous discovered check", async () => {
    const root = await repo();
    const { registry } = await loadRegistry(root);
    const adapter = stubAdapter({ discovered: [], results: [] });

    const run = await runNegativeControl({
      registry,
      root,
      adapters: [adapter],
      discovered: [check(), { ...check(), file: "src/other.test.ts" }],
    });

    expect(run.executed).toBe(false);
    expect(run.errors.map((finding) => finding.code)).toContain("negative.check_ambiguous");
  });
});
