import { describe, expect, it } from "vitest";
import { checkDeclared } from "../../src/negative/declared.js";
import type { Finding } from "../../src/registry/model.js";
import { loadRegistry } from "../../src/registry/load.js";
import { makeTmpRepo } from "../helpers/fixture.js";
import { capability, type CapabilityOverrides } from "../helpers/registry.js";

const SABOTAGE = ".invariant/sabotages/sales/stock.ts";
const TARGET = "packages/app/src/seams/stock-policy.ts";
const GOOD_SABOTAGE = `// @seam-alias ${TARGET}\nexport const available = () => ({ available: () => Infinity });\n`;

async function findingsFor(
  sabotage: string | null,
  overrides: CapabilityOverrides = {},
  extra: Record<string, string> = {},
): Promise<Finding[]> {
  const files: Record<string, string> = {
    "rules/sales.yaml": capability("SALES-004", overrides),
    [TARGET]: "export const available = () => ({ available: () => 1 });\n",
    ...extra,
  };
  if (sabotage !== null) files[SABOTAGE] = sabotage;
  const root = await makeTmpRepo(files);
  const { registry } = await loadRegistry(root);
  return await checkDeclared(registry, root);
}

describe("checkDeclared (spec §8 stage 6, PEND-1)", () => {
  it("accepts a sabotage that exists and declares exactly one @seam-alias", async () => {
    expect(await findingsFor(GOOD_SABOTAGE)).toEqual([]);
  });

  it("rejects a missing sabotage file", async () => {
    expect((await findingsFor(null)).map((finding) => finding.code)).toContain(
      "negative.sabotage_missing",
    );
  });

  it("rejects a sabotage with no @seam-alias", async () => {
    expect((await findingsFor("export const available = () => Infinity;\n")).map((f) => f.code)).toContain(
      "negative.seam_alias_missing",
    );
  });

  it("rejects more than one @seam-alias", async () => {
    const sabotage = `// @seam-alias ${TARGET}\n// @seam-alias ${TARGET}\n`;
    expect((await findingsFor(sabotage)).map((finding) => finding.code)).toContain(
      "negative.seam_alias_duplicate",
    );
  });

  it("rejects an alias pointing at the sabotage itself", async () => {
    const sabotage = `// @seam-alias ${SABOTAGE}\n`;
    expect((await findingsFor(sabotage)).map((finding) => finding.code)).toContain(
      "negative.seam_alias_target_invalid",
    );
  });

  it("rejects an alias that escapes the repo, is absolute or names no file", async () => {
    for (const alias of ["../outside.ts", "/etc/passwd", "src/missing.ts"]) {
      const codes = (await findingsFor(`// @seam-alias ${alias}\n`)).map((finding) => finding.code);
      expect(codes).toContain("negative.seam_alias_target_invalid");
    }
  });

  it("does not examine draft or deprecated rules", async () => {
    for (const status of ["draft", "deprecated"] as const) {
      const overrides: CapabilityOverrides =
        status === "deprecated" ? { status, retired: true } : { status };
      expect(await findingsFor(null, overrides)).toEqual([]);
    }
  });

  it("always names the sabotage file, the rule and the check", async () => {
    const [finding] = await findingsFor(null);
    expect(finding).toMatchObject({
      file: SABOTAGE,
      ruleId: "SALES-004",
      checkId: "sales.rejects-insufficient-stock",
    });
  });
});
