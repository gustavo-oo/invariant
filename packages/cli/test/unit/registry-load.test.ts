import { describe, expect, it } from "vitest";
import { loadRegistry } from "../../src/registry/load.js";
import { loadConfig } from "../../src/config/load.js";
import { makeTmpRepo } from "../helpers/fixture.js";

describe("loadRegistry", () => {
  it("reads capabilities and flows with line numbers", async () => {
    const root = await makeTmpRepo({
      "rules/sales.yaml": `capability: sales\nrules:\n  - id: SALES-004\n    statement: "A sale MUST NOT complete when stock is insufficient."\n    rationale: "Prevents overselling."\n    criticality: critical\n    status: enforced\n    owners: [team-commerce]\n    checks:\n      - id: sales.rejects-insufficient-stock\n        layer: integration\n        negative_control:\n          kind: seam\n          seam: "buildApp({ stockPolicy })"\n          sabotage: .invariant/sabotages/sales/stock.ts\n`,
    });
    const { registry, findings } = await loadRegistry(root);
    expect(findings).toEqual([]);
    expect(registry.rules).toHaveLength(1);
    expect(registry.rules[0]?.id).toBe("SALES-004");
    expect(registry.rules[0]?.checks[0]?.negativeControl?.sabotage).toBe(".invariant/sabotages/sales/stock.ts");
    expect(registry.rules[0]?.source).toEqual({ file: "rules/sales.yaml", line: 3 });
  });

  it("splits CRLF and strips a UTF-8 BOM (review focus 3)", async () => {
    const root = await makeTmpRepo({ "rules/sales.yaml": "\uFEFFcapability: sales\r\nrules: []\r\n" });
    const { findings } = await loadRegistry(root);
    expect(findings).toEqual([]);
  });

  it("rejects a capability file whose name does not match its capability (PEND-9)", async () => {
    const root = await makeTmpRepo({ "rules/sales.yaml": "capability: billing\nrules: []\n" });
    const { findings } = await loadRegistry(root);
    expect(findings.map((f) => f.code)).toEqual(["registry.file_capability_mismatch"]);
  });

  it("reads a flow document with line numbers (PEND-9)", async () => {
    const root = await makeTmpRepo({
      "rules/flows/checkout.yaml": `flows:\n  - id: checkout\n    name: Complete a sale\n    owner: team-commerce\n    criticality: critical\n    steps:\n      - id: s1\n        name: Validate cart\n        rules: [SALES-004]\n    checks:\n      - id: checkout.completes-a-sale\n        layer: e2e\n`,
    });
    const { registry, findings } = await loadRegistry(root);
    expect(findings).toEqual([]);
    expect(registry.flows).toHaveLength(1);
    expect(registry.flows[0]?.id).toBe("checkout");
    expect(registry.flows[0]?.source).toEqual({ file: "rules/flows/checkout.yaml", line: 2 });
    expect(registry.files).toEqual(["rules/flows/checkout.yaml"]);
  });

  it("rejects a flow file whose single flow id does not match its name (PEND-9)", async () => {
    const root = await makeTmpRepo({
      "rules/flows/checkout.yaml": "flows:\n  - id: other\n    name: n\n    owner: o\n    criticality: normal\n    steps: []\n    checks: []\n",
    });
    const { findings } = await loadRegistry(root);
    expect(findings.map((f) => f.code)).toEqual(["registry.flow_file_id_mismatch"]);
  });

  it("propagates a directory-read error instead of treating it as no rules (review fix)", async () => {
    // `rules` is a regular file, so readdir fails with ENOTDIR. Only ENOENT may
    // mean "no matches"; any other traversal error must surface, never become an
    // empty (and therefore accepably green) registry.
    const root = await makeTmpRepo({ rules: "not a directory" });
    await expect(loadRegistry(root)).rejects.toThrow(/ENOTDIR/);
  });
});

describe("loadConfig", () => {
  it("applies documented defaults when .invariant/config.yaml is absent (review focus 1)", async () => {
    const root = await makeTmpRepo({ "rules/sales.yaml": "capability: sales\nrules: []\n" });
    const { config, findings } = await loadConfig(root);
    expect(findings).toEqual([]);
    expect(config.adapter).toBe("vitest");
    expect(config.scope.mode).toBe("advisory");
    expect(config.skill.distribution).toBe("manifest-only");
    expect(config.credentialBoundary).toBe("none");
    expect(config.ruleChange.label).toBe("invariant:rule-change");
    expect(config.doctor.expectedAppId).toBe(15368);
    expect(config.protectedPaths).toEqual(["rules/", ".invariant/", ".github/workflows/invariant.yml", ".github/CODEOWNERS"]);
  });

  it("overlays a present config on the defaults and reports a schema violation", async () => {
    const root = await makeTmpRepo({
      ".invariant/config.yaml": "adapter: custom\nscope:\n  mode: blocking\ncredentialBoundary: declared\nbogus: 1\n",
    });
    const { config, findings } = await loadConfig(root);
    expect(config.adapter).toBe("custom");
    expect(config.scope.mode).toBe("blocking");
    expect(config.credentialBoundary).toBe("declared");
    expect(config.doctor.apiUrl).toBe("https://api.github.com");
    expect(findings.map((f) => f.code)).toEqual(["config.schema"]);
  });
});
