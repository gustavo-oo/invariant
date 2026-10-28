import { describe, expect, it } from "vitest";
import { runVerify } from "../../src/commands/verify.js";
import { makeTmpRepo } from "../helpers/fixture.js";

describe("SELF-002", () => {
  // @check self.no-orphan-checks
  // @rule SELF-002
  // @flow self-verify/s1
  it("rejects a tagged check that no rule declares", async () => {
    const root = await makeTmpRepo({
      "src/orphan.test.ts": `import { test } from "vitest";\n\n// @check sales.orphan\n// @rule SALES-999\ntest("orphan", () => {});\n`,
    });

    const { report, code } = await runVerify({ root });
    expect(code).toBe(2);
    expect(report.integrity.map((finding) => finding.code)).toContain(
      "integrity.check_without_registry_declaration",
    );
  });
});
