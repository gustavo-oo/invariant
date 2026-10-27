import { describe, expect, it } from "vitest";
import { makeTmpRepo } from "../helpers/fixture.js";
import { expectGolden } from "../helpers/goldens.js";
import { runFixture, spawnCli } from "../helpers/run-cli.js";

describe("invariant validate integrity", () => {
  it("exits 2 when a rule declares a check that no test implements", async () => {
    const run = await runFixture("orphan-check");
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("integrity.rule_without_discovered_check");
    await expectGolden("orphan-check", run.stderr, "stderr.txt");
  });

  it("exits 2 when one @check id is tagged on two distinct tests", async () => {
    const run = await runFixture("duplicate-tag");
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("integrity.duplicate_check_tag");
    await expectGolden("duplicate-tag", run.stderr, "stderr.txt");
  });

  it("exits 2 when a @rule tag does not match the registry id exactly", async () => {
    const run = await runFixture("tag-case-mismatch");
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("integrity.unknown_rule_id");
    expect(run.stderr).toContain("sales-004");
    await expectGolden("tag-case-mismatch", run.stderr, "stderr.txt");
  });

  it("emits integrity findings through --json like any other finding", async () => {
    const run = await runFixture("orphan-check", { args: ["validate", "--json"] });
    expect(run.exitCode).toBe(2);
    const parsed = JSON.parse(run.stdout) as { findings: Array<{ code: string; file: string }> };
    expect(parsed.findings.map((finding) => finding.code)).toEqual(["integrity.rule_without_discovered_check"]);
    expect(parsed.findings[0]?.file).toBe("rules/sales.yaml");
  });

  it("does not run discovery when the registry is invalid (R37)", async () => {
    // The test file cannot be parsed, so discovery would add an
    // integrity.discovery_error; an invalid registry must stop before discovery.
    const root = await makeTmpRepo({
      "rules/sales.yaml": `capability: sales
rules:
  - id: SALES-4
    statement: "A sale MUST NOT complete when stock is insufficient."
    rationale: "Prevents overselling."
    criticality: normal
    status: enforced
    owners: [team-commerce]
    checks:
      - id: sales.some-check
        layer: unit
        negative_control:
          kind: seam
          seam: buildApp({ stockPolicy })
          sabotage: .invariant/sabotages/sales/stock.ts
`,
      "src/broken.test.ts": "test(\n",
    });

    const run = await spawnCli(["validate"], { cwd: root });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("registry.invalid_id");
    expect(run.stderr).not.toContain("integrity.discovery_error");
  });
});
