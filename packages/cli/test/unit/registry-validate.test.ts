import { describe, expect, it } from "vitest";
import { validateRegistry } from "../../src/registry/validate.js";
import { loadRegistry } from "../../src/registry/load.js";
import { DEFAULT_CONFIG } from "../../src/config/model.js";
import { makeTmpRepo } from "../helpers/fixture.js";
import { capability, codesForFlow, flow } from "../helpers/registry.js";
import type { Finding } from "../../src/registry/validate.js";

// capability(id, overrides) returns the YAML text of a one-rule capability document.
const codes = async (yaml: string) => {
  const { registry } = await loadRegistry(await makeTmpRepo({ "rules/sales.yaml": yaml }));
  return validateRegistry(registry, { cwd: "/x", config: DEFAULT_CONFIG }).map((f) => f.code).sort();
};

describe("validateRegistry (spec §5.1)", () => {
  it("rejects an id that does not match ^[A-Z][A-Z0-9]*-\\d{3}$", async () => {
    expect(await codes(capability("SALES-4"))).toContain("registry.invalid_id");
  });
  it("rejects an enforced rule with no check", async () => {
    expect(await codes(capability("SALES-004", { checks: [] }))).toContain("registry.enforced_without_check");
  });
  it("rejects an enforced rule with no owners", async () => {
    expect(await codes(capability("SALES-004", { owners: [] }))).toContain("registry.enforced_without_owners");
  });
  it("rejects any negative_control kind other than seam", async () => {
    expect(await codes(capability("SALES-004", { kind: "counter-example" }))).toContain("registry.negative_control_kind_unsupported");
  });
  it("rejects a sabotage path outside .invariant/sabotages/", async () => {
    expect(await codes(capability("SALES-004", { sabotage: "scripts/break-it.ts" }))).toContain("registry.sabotage_path_invalid");
  });
  it("rejects a duplicate check id across the registry", async () => {
    expect(await codes(capability("SALES-004", { checkId: "sales.a" }))).toContain("registry.duplicate_check_id");
  });
  it("rejects a deprecated rule with no replacement", async () => {
    expect(await codes(capability("SALES-004", { status: "deprecated", checks: [] }))).toContain("registry.deprecated_without_replacement");
  });
  it("accepts a draft rule with no checks and no seam (spec §5.3)", async () => {
    expect(await codes(capability("SALES-004", { status: "draft", checks: [] }))).toEqual([]);
  });
  it("accepts a zero-enforced-rule registry and reports no findings (review focus 5)", async () => {
    expect(await codes("capability: sales\nrules: []\n")).toEqual([]);
  });
});

describe("validateRegistry (spec §5.2)", () => {
  it("requires an e2e check on a critical flow", async () => {
    expect(await codesForFlow(flow({ criticality: "critical", layer: "integration" }))).toContain("flow.critical_without_e2e");
  });
  it("requires a referenced rule to exist and each step to carry one", async () => {
    expect(await codesForFlow(flow({ stepRules: ["SALES-999"] }))).toContain("flow.unknown_rule");
    expect(await codesForFlow(flow({ stepRules: [] }))).toContain("flow.step_without_rules");
  });
  it("requires unique step ids per flow", async () => {
    expect(await codesForFlow(flow({ stepIds: ["s1", "s1"] }))).toContain("flow.duplicate_step_id");
  });
});

// The brief's table has one code per test above; these cover the remaining §5
// codes and the paths a schema-valid document cannot express.
describe("validateRegistry (remaining §5 codes)", () => {
  const codesOf = async (files: Record<string, string>) => {
    const { registry } = await loadRegistry(await makeTmpRepo(files));
    return validateRegistry(registry, { cwd: "/x", config: DEFAULT_CONFIG }).map((f) => f.code).sort();
  };

  it("rejects a duplicate rule id across the registry", async () => {
    const result = await codesOf({
      "rules/a.yaml": capability("SALES-004"),
      "rules/b.yaml": capability("SALES-004"),
    });
    expect(result).toContain("registry.duplicate_rule_id");
  });

  it("rejects an empty statement and an empty rationale", async () => {
    expect(await codes(capability("SALES-004", { statement: "  " }))).toContain("registry.missing_statement");
    expect(await codes(capability("SALES-004", { rationale: "" }))).toContain("registry.missing_rationale");
  });

  it("rejects an enforced check without a negative control", async () => {
    const yaml = capability("SALES-004", { checks: [{ id: "sales.a", layer: "unit" }] });
    expect(await codes(yaml)).toContain("registry.enforced_without_negative_control");
  });

  it("rejects sabotage paths that escape via .. or an absolute path, and non-strings", async () => {
    expect(await codes(capability("SALES-004", { sabotage: ".invariant/sabotages/../../src/app.ts" }))).toContain(
      "registry.sabotage_path_invalid",
    );
    expect(await codes(capability("SALES-004", { sabotage: "/tmp/break-it.ts" }))).toContain("registry.sabotage_path_invalid");
    const numeric = capability("SALES-004", {
      checks: [{ id: "sales.a", layer: "unit", negative_control: { kind: "seam", seam: "s", sabotage: 42 } }],
    });
    expect(await codes(numeric)).toContain("registry.sabotage_path_invalid");
  });

  it("accepts a deprecated rule that is retired or points at an existing rule", async () => {
    expect(await codes(capability("SALES-004", { status: "deprecated", checks: [], retired: true }))).toEqual([]);
    expect(await codes(capability("SALES-004", { status: "deprecated", checks: [], replacedBy: "SALES-004" }))).toEqual([]);
  });

  it("rejects a duplicate flow id across the registry", async () => {
    const result = await codesOf({
      "rules/sales.yaml": capability("SALES-004"),
      "rules/flows/a.yaml": flow({ id: "checkout" }),
      "rules/flows/b.yaml": flow({ id: "checkout" }),
    });
    expect(result).toContain("flow.duplicate_flow_id");
  });

  it("accepts a critical flow that has an e2e check", async () => {
    expect(await codesForFlow(flow({ criticality: "critical", layer: "e2e" }))).toEqual([]);
  });
});
