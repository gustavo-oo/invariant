import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { makeVitestRepo } from "../helpers/fixture.js";
import { expectGolden, normalizeReport } from "../helpers/goldens.js";
import { CLI_PATH, spawnCli } from "../helpers/run-cli.js";

function env(): NodeJS.ProcessEnv {
  const copy = { ...process.env };
  for (const name of [
    "INVARIANT_DOCTOR_TOKEN",
    "GITHUB_REPOSITORY",
    "GITHUB_RUN_ID",
    "GITHUB_EVENT_PATH",
  ]) {
    delete copy[name];
  }
  return copy;
}

const PACKAGE = JSON.stringify({ name: "walking-demo", type: "module", private: true });

describe("walking skeleton (spec §10)", () => {
  let root: string;

  beforeAll(async () => {
    root = await makeVitestRepo({ "package.json": PACKAGE });
    const init = await spawnCli(
      [
        "init",
        root,
        "--owner",
        "@alice",
        "--cli-setup",
        "true",
        "--invariant-cmd",
        `node ${CLI_PATH}`,
      ],
      { cwd: root, env: env() },
    );
    expect(init.exitCode).toBe(0);
    expect(init.stdout).toContain("class: G3 (procedural)");
  });

  it("is green after init, and red with exit 1 when the rule's behaviour is broken", async () => {
    const green = await spawnCli(
      [
        "verify",
        "--root",
        root,
        "--out",
        "invariant-report.json",
        "--comment",
        "invariant-comment.md",
      ],
      { cwd: root, env: env() },
    );
    expect(green.exitCode).toBe(0);

    const report = normalizeReport(
      JSON.parse(await readFile(path.join(root, "invariant-report.json"), "utf8")) as unknown,
    );
    expect(report.rules.find((rule) => rule.rule_id === "EXAMPLE-001")).toMatchObject({
      verdict: "pass",
      sabotage_verified: false,
    });
    expect(report.guarantee).toMatchObject({
      class: "G3",
      negative_control: "declared-only",
    });
    await expectGolden("walking-skeleton", report, "report.json");
    await expectGolden(
      "walking-skeleton",
      await readFile(path.join(root, "invariant-comment.md"), "utf8"),
      "comment.md",
    );

    // Break the rule: the limiter stops consulting the injected policy.
    await writeFile(
      path.join(root, "invariant-example/limiter.ts"),
      "export function createLimiter() { return { request: () => ({ status: 200 }) }; }\n",
      "utf8",
    );

    const red = await spawnCli(["verify", "--root", root], { cwd: root, env: env() });
    expect(red.exitCode).toBe(1);
    expect(red.stdout).toContain("1 not green");
  });

  it("exits 2 when the registry is made invalid", async () => {
    await writeFile(
      path.join(root, "rules/example.yaml"),
      `capability: example
rules:
  - id: EXAMPLE-001
    statement: "A request exceeding the injected limit MUST be rejected."
    rationale: "The injected policy is the contract with the caller."
    criticality: critical
    status: enforced
    owners: ["@alice"]
    checks: []
`,
      "utf8",
    );

    const invalid = await spawnCli(["verify", "--root", root], { cwd: root, env: env() });
    expect(invalid.exitCode).toBe(2);
  });
});
