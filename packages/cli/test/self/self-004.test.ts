import { describe, expect, it } from "vitest";
import { runVerify } from "../../src/commands/verify.js";
import { isProof } from "../../src/verdict/proof.js";
import type { SabotageOutcome } from "../../src/verdict/types.js";
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

  it("records declared-only and no proof for a green enforced repository", async () => {
    const root = await makeVitestRepo({
      "package.json": JSON.stringify({ name: "self-004", type: "module", private: true }),
      "rules/sales.yaml": capability("SALES-004"),
      "src/sale.test.ts": `import { expect, test } from "vitest";\n\n// @check sales.rejects-insufficient-stock\n// @rule SALES-004\ntest("rejects insufficient stock", () => { expect(1).toBe(1); });\n`,
      ".invariant/sabotages/sales/stock.ts":
        "// @seam-alias src/stock-policy.ts\nexport const policy = () => ({ available: () => Infinity });\n",
      "src/stock-policy.ts": "export const policy = () => ({ available: () => 1 });\n",
    });

    const { report, code } = await runVerify({ root });
    expect(code).toBe(0);
    expect(report.guarantee.negative_control).toBe("declared-only");
    expect(report.rules.every((rule) => rule.sabotage_verified === false)).toBe(true);
  });
});
