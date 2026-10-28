import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { checkDeclared } from "../../src/negative/declared.js";
import { reconcile } from "../../src/registry/integrity.js";
import { loadRegistry } from "../../src/registry/load.js";
import { validateRegistry } from "../../src/registry/validate.js";
import { createDiscoverySource } from "../../src/seams/discovery-source.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

describe("dogfood registry", () => {
  // @check self-verify.runs
  // @flow self-verify
  it("validates, links and reconciles with zero findings", async () => {
    const { registry, findings } = await loadRegistry(REPO_ROOT);
    const { config } = await loadConfig(REPO_ROOT);

    expect(findings).toEqual([]);
    expect(validateRegistry(registry, { cwd: REPO_ROOT, config })).toEqual([]);
    expect(reconcile(registry, await createDiscoverySource(config).discover(REPO_ROOT))).toEqual([]);
    expect(registry.rules.map((rule) => rule.id).sort()).toEqual([
      "SELF-001",
      "SELF-002",
      "SELF-003",
      "SELF-004",
      "SELF-005",
    ]);
    expect(await checkDeclared(registry, REPO_ROOT)).toEqual([]);
  });
});
