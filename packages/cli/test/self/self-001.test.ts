import { describe, expect, it } from "vitest";
import { runVerify } from "../../src/commands/verify.js";
import { makeVitestRepo } from "../helpers/fixture.js";
import { capability } from "../helpers/registry.js";

describe("SELF-001", () => {
  // @check self.not-run-fails
  // @rule SELF-001
  // @flow self-verify/s1
  it("treats a not-run check of an enforced rule as a failure", async () => {
    const root = await makeVitestRepo({
      "package.json": JSON.stringify({ name: "self-001", type: "module", private: true }),
      "rules/sales.yaml": capability("SALES-004"),
      "src/sale.test.ts": `import { test } from "vitest";\n\n// @check sales.rejects-insufficient-stock\n// @rule SALES-004\ntest.skip("rejects insufficient stock", () => {});\n`,
      ".invariant/sabotages/sales/stock.ts":
        "// @seam-alias src/stock-policy.ts\nexport const policy = () => ({ available: () => Infinity });\n",
      "src/stock-policy.ts": "export const policy = () => ({ available: () => 1 });\n",
    });

    const { report, code } = await runVerify({ root });
    expect(report.rules.find((rule) => rule.rule_id === "SALES-004")?.verdict).toBe("not-run");
    expect(code).toBe(1);
  });
});
