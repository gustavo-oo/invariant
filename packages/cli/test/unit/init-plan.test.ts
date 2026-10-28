import { describe, expect, it } from "vitest";
import { defaultBaseline } from "../../src/doctor/baseline.js";
import { applyInit, planInit } from "../../src/init/plan.js";
import { makeTmpRepo } from "../helpers/fixture.js";

const G3 = defaultBaseline();

function input(
  root: string,
  over: Partial<Parameters<typeof planInit>[0]> = {},
): Parameters<typeof planInit>[0] {
  return {
    root,
    owner: "@alice",
    adapter: "vitest",
    cliSetup: "npm i",
    invariantCmd: "npx --no-install invariant",
    invariantVersion: "0.1.0",
    baseline: G3,
    ...over,
  };
}

describe("planInit", () => {
  it("creates the walking skeleton, the config, the workflow, the ruleset and the baseline", async () => {
    const plan = await planInit(input(await makeTmpRepo({})));

    expect(plan.writes.map((write) => write.path).sort()).toEqual([
      ".github/CODEOWNERS",
      ".github/workflows/invariant.yml",
      ".invariant/config.yaml",
      ".invariant/protection-baseline.json",
      ".invariant/protection.ruleset.json",
      ".invariant/sabotages/example/limit-unbounded.ts",
      "invariant-example/README.md",
      "invariant-example/limiter.test.ts",
      "invariant-example/limiter.ts",
      "rules/example.yaml",
      "rules/flows/example-request.yaml",
    ]);
    expect(plan.findings).toEqual([]);
  });

  it("renders a ruleset that requires exactly invariant-verdict pinned to the expected app", async () => {
    const plan = await planInit(input(await makeTmpRepo({})));
    const write = plan.writes.find((item) => item.path === ".invariant/protection.ruleset.json");
    const ruleset = JSON.parse(write?.content ?? "null") as {
      target: string;
      enforcement: string;
      conditions: unknown;
      bypass_actors: unknown[];
      rules: unknown[];
    };

    expect(ruleset).toMatchObject({
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
      bypass_actors: [],
    });
    expect(ruleset.rules).toContainEqual({
      type: "required_status_checks",
      parameters: {
        required_status_checks: [{ context: "invariant-verdict", integration_id: 15368 }],
        strict_required_status_checks_policy: true,
      },
    });
    expect(ruleset.rules).toContainEqual({
      type: "pull_request",
      parameters: {
        require_code_owner_review: true,
        required_approving_review_count: 1,
        dismiss_stale_reviews_on_push: true,
        require_last_push_approval: false,
        required_review_thread_resolution: true,
      },
    });
  });

  it("never overwrites an existing file and appends the CODEOWNERS block once (idempotent)", async () => {
    const root = await makeTmpRepo({
      "README.md": "mine",
      ".github/CODEOWNERS": "/docs/ @alice\n",
    });
    const first = await planInit(input(root));

    expect(first.writes.find((write) => write.path === "README.md")).toBeUndefined();
    const codeowners = first.writes.find((write) => write.path === ".github/CODEOWNERS");
    expect(codeowners).toMatchObject({ mode: "append-block" });
    expect(codeowners?.content.match(/>>> invariant >>>/g)).toHaveLength(1);

    await applyInit(root, first.writes);
    const second = await planInit(input(root));
    expect(second.writes.filter((write) => write.mode === "create")).toEqual([]);
    expect(second.writes.find((write) => write.path === ".github/CODEOWNERS")).toMatchObject({
      mode: "skip",
    });
  });

  it("skips the skeleton rule when EXAMPLE-001 already exists elsewhere", async () => {
    const root = await makeTmpRepo({
      "rules/other.yaml": `capability: other
rules:
  - id: EXAMPLE-001
    statement: "Existing."
    rationale: "Existing."
    criticality: normal
    status: draft
    checks: []
`,
    });
    const plan = await planInit(input(root));

    expect(plan.writes.find((write) => write.path === "rules/example.yaml")).toMatchObject({
      mode: "skip",
    });
    expect(plan.findings.map((finding) => finding.code)).toContain("init.example_rule_exists");
  });
});
