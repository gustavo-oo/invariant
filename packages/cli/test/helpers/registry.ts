/**
 * Shared registry-YAML builders for tests: a one-rule capability document, a
 * flow document, and the loader+validator round trip used by the §5.2 tests.
 *
 * They live here (not in a test file) because Tasks 7, 14 and 23 reuse them.
 */
import { stringify } from "yaml";
import { DEFAULT_CONFIG } from "../../src/config/model.js";
import { loadRegistry } from "../../src/registry/load.js";
import { validateRegistry } from "../../src/registry/validate.js";
import { makeTmpRepo } from "./fixture.js";

export interface CapabilityOverrides {
  status?: "draft" | "enforced" | "deprecated";
  criticality?: "critical" | "normal";
  statement?: string;
  rationale?: string;
  owners?: string[];
  /** Replace the generated checks wholesale (e.g. `[]`). */
  checks?: unknown[];
  /** Two checks share this id, making the duplicate real inside one rule. */
  checkId?: string;
  kind?: string;
  seam?: string;
  sabotage?: string;
  replacedBy?: string;
  retired?: boolean;
}

const DEFAULT_NEGATIVE_CONTROL = {
  kind: "seam",
  seam: "buildApp({ stockPolicy })",
  sabotage: ".invariant/sabotages/sales/stock.ts",
};

/**
 * The YAML text of a capability document with exactly one rule.
 *
 * Every generated document is schema-valid except when an override deliberately
 * supplies the invalid value under test (`kind`, `sabotage`) — the schema checks
 * structure, the validator checks §5.
 */
export function capability(id: string, overrides: CapabilityOverrides = {}): string {
  const checks = overrides.checks ?? generatedChecks(overrides);
  const rule: Record<string, unknown> = {
    id,
    statement: overrides.statement ?? "A sale MUST NOT complete when stock is insufficient.",
    rationale: overrides.rationale ?? "Prevents overselling.",
    criticality: overrides.criticality ?? "critical",
    status: overrides.status ?? "enforced",
    owners: overrides.owners ?? ["team-commerce"],
    checks,
  };
  if (overrides.replacedBy !== undefined) rule["replaced_by"] = overrides.replacedBy;
  if (overrides.retired !== undefined) rule["retired"] = overrides.retired;
  return stringify({ capability: "sales", rules: [rule] }, { lineWidth: 0 });
}

function generatedChecks(overrides: CapabilityOverrides): unknown[] {
  const check = {
    id: overrides.checkId ?? "sales.rejects-insufficient-stock",
    layer: "integration",
    negative_control: {
      kind: overrides.kind ?? DEFAULT_NEGATIVE_CONTROL.kind,
      seam: overrides.seam ?? DEFAULT_NEGATIVE_CONTROL.seam,
      sabotage: overrides.sabotage ?? DEFAULT_NEGATIVE_CONTROL.sabotage,
    },
  };
  // `checkId` deliberately emits the SAME id twice: the duplicate-check-id case
  // must be a real pair of checks inside one rule, not a helper artefact.
  return overrides.checkId === undefined ? [check] : [check, { ...check }];
}

export interface FlowOverrides {
  id?: string;
  criticality?: "critical" | "normal";
  /** Layer of the single generated flow check (default `e2e`). */
  layer?: "unit" | "integration" | "e2e";
  stepIds?: string[];
  stepRules?: string[];
  /** Replace the generated flow checks wholesale. */
  checks?: unknown[];
}

/** The YAML text of a one-flow document. */
export function flow(overrides: FlowOverrides = {}): string {
  const id = overrides.id ?? "checkout";
  const stepIds = overrides.stepIds ?? ["s1"];
  const stepRules = overrides.stepRules ?? ["SALES-004"];
  return stringify(
    {
      flows: [
        {
          id,
          name: "Complete a sale",
          owner: "team-commerce",
          criticality: overrides.criticality ?? "normal",
          steps: stepIds.map((stepId) => ({ id: stepId, name: `Step ${stepId}`, rules: [...stepRules] })),
          checks: overrides.checks ?? [{ id: `${id}.completes-a-sale`, layer: overrides.layer ?? "e2e" }],
        },
      ],
    },
    { lineWidth: 0 },
  );
}

/**
 * Write `capability: sales` declaring the valid rule `SALES-004` plus the flow
 * document under test, load the whole registry, and return the sorted §5 codes.
 * The capability makes every default flow reference resolve, so a test that
 * expects `flow.unknown_rule` must reference a genuinely absent rule.
 */
export async function codesForFlow(flowYaml: string): Promise<string[]> {
  const root = await makeTmpRepo({
    "rules/sales.yaml": capability("SALES-004"),
    "rules/flows/checkout.yaml": flowYaml,
  });
  const { registry } = await loadRegistry(root);
  return validateRegistry(registry, { cwd: root, config: DEFAULT_CONFIG })
    .map((finding) => finding.code)
    .sort();
}
