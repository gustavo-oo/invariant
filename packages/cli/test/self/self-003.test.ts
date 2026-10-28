import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runVerify } from "../../src/commands/verify.js";
import { commitAll, makeGitRepo, makeVitestRepo } from "../helpers/fixture.js";
import { capability } from "../helpers/registry.js";

describe("SELF-003", () => {
  // @check self.immutability
  // @rule SELF-003
  // @flow self-verify/s2
  it("fails a rule change outside the flagged path, and passes it with the label", async () => {
    const { root, baseSha } = await makeGitRepo({
      "package.json": JSON.stringify({ name: "self-003", type: "module", private: true }),
      "rules/sales.yaml": capability("SALES-004"),
      "src/sale.test.ts": `import { expect, test } from "vitest";\nimport { policy } from "./stock-policy";\n\n// @check sales.rejects-insufficient-stock\n// @rule SALES-004\n// @negative-control .invariant/sabotages/sales/stock.ts\ntest("rejects insufficient stock", () => { expect(policy().available()).toBe(1); });\n`,
      ".invariant/sabotages/sales/stock.ts":
        "// @seam-alias src/stock-policy.ts\nexport const policy = () => ({ available: () => Infinity });\n",
      "src/stock-policy.ts": "export const policy = () => ({ available: () => 1 });\n",
    });
    await makeVitestRepo({}, { into: root });

    const rule = await readFile(path.join(root, "rules/sales.yaml"), "utf8");
    await writeFile(
      path.join(root, "rules/sales.yaml"),
      rule.replace("Prevents overselling.", "Prevents overselling at any price."),
      "utf8",
    );
    const headSha = await commitAll(root, "amend the rule");

    const event = (labels: string[]): string =>
      JSON.stringify({
        pull_request: {
          base: { sha: baseSha },
          head: { sha: headSha },
          labels: labels.map((name) => ({ name })),
        },
      });
    await writeFile(path.join(root, "event.json"), event([]), "utf8");
    await writeFile(path.join(root, "event-flagged.json"), event(["invariant:rule-change"]), "utf8");

    const red = await runVerify({ root, base: baseSha, event: "event.json" });
    expect(red.code).toBe(1);
    expect(red.report.immutability).toMatchObject({ protected_paths_changed: ["rules/sales.yaml"] });
    expect(red.report.integrity.map((finding) => finding.code)).toContain(
      "immutability.protected_path_changed",
    );
    expect(red.report.rules.map((rule) => rule.verdict)).toEqual(["pass"]);

    const flagged = await runVerify({ root, base: baseSha, event: "event-flagged.json" });
    expect(flagged.code).toBe(0);
    expect(flagged.report.immutability.flagged).toBe(true);
  }, 30_000);
});
