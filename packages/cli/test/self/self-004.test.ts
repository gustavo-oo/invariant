import { describe, expect, it } from "vitest";
import { isProof } from "../../src/verdict/proof.js";
import type { SabotageOutcome } from "../../src/verdict/types.js";
import { runVerify } from "../../src/commands/verify.js";
import { makeVitestRepo } from "../helpers/fixture.js";
import { capability } from "../helpers/registry.js";

const OUTCOMES: SabotageOutcome[] = [
  { status: "not-executed" },
  { status: "not-applied" },
  { status: "applied", classification: "assertion" },
  { status: "applied", classification: "harness" },
  { status: "applied", classification: "timeout" },
];

describe("SELF-004", () => {
  // @check self.proof-decision
  // @rule SELF-004
  // @flow self-verify/s3
  it("counts only an applied, assertion-classified failure as proof", () => {
    expect(OUTCOMES.map(isProof)).toEqual([false, false, true, false, false]);
  });

  it("records executed and a proof for a fixture that exercises its seam", async () => {
    const root = await makeVitestRepo({
      "package.json": JSON.stringify({ name: "self-004", type: "module", private: true }),
      "rules/sales.yaml": capability("SALES-004"),
      "src/sale.test.ts": `import { expect, test } from "vitest";\nimport { policy } from "./stock-policy";\n\n// @check sales.rejects-insufficient-stock\n// @rule SALES-004\ntest("rejects insufficient stock", () => { expect(policy().available()).toBe(1); });\n`,
      ".invariant/sabotages/sales/stock.ts":
        "// @seam-alias src/stock-policy.ts\nexport const policy = () => ({ available: () => Infinity });\n",
      "src/stock-policy.ts": "export const policy = () => ({ available: () => 1 });\n",
    });

    const { report, code } = await runVerify({ root });
    expect(code).toBe(0);
    expect(report.guarantee.negative_control).toBe("executed");
    expect(report.rules.every((rule) => rule.sabotage_verified === true)).toBe(true);
  });

  it("blocks a green check whose seam is never exercised", async () => {
    const root = await makeVitestRepo({
      "package.json": JSON.stringify({ name: "self-004-noop", type: "module", private: true }),
      "rules/sales.yaml": capability("SALES-004"),
      "src/sale.test.ts": `import { expect, test } from "vitest";\n\n// @check sales.rejects-insufficient-stock\n// @rule SALES-004\ntest("rejects insufficient stock", () => { expect(1).toBe(1); });\n`,
      ".invariant/sabotages/sales/stock.ts":
        "// @seam-alias src/stock-policy.ts\nexport const policy = () => ({ available: () => Infinity });\n",
      "src/stock-policy.ts": "export const policy = () => ({ available: () => 1 });\n",
    });

    const { report, code } = await runVerify({ root });
    expect(code).toBe(1);
    expect(report.rules[0]).toMatchObject({ verdict: "blocked", sabotage_verified: false });
  });
});
