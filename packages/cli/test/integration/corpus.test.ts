import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commitAll, makeGitRepo } from "../helpers/fixture.js";
import { expectGolden, normalizeReport } from "../helpers/goldens.js";
import { runFixture, spawnCli } from "../helpers/run-cli.js";

const CASES = [
  "orphan-rule",
  "orphan-check",
  "duplicate-tag",
  "not-run-check",
  "sabotage-missing-alias",
  "sabotage-does-not-compile",
  "no-op-sabotage",
  "invalid-registry",
  "upstream-cancelled",
  "flaky-check",
  "rule-changed-in-feature-pr",
  "rule-changed-flagged",
  "report-missing",
  "tag-case-mismatch",
  "empty-registry",
  "healthy-registry",
  "no-protection",
] as const;

interface Expected {
  args: string[];
  exit_code: number;
  setup?: "git-rule-change";
}

function fixtureFile(name: string, file: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}/${file}`, import.meta.url));
}

async function expectedFor(name: string): Promise<Expected> {
  return JSON.parse(await readFile(fixtureFile(name, "expected.json"), "utf8")) as Expected;
}

function hermeticEnv(): NodeJS.ProcessEnv {
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

async function healthyFiles(): Promise<Record<string, string>> {
  const names = [
    "rules/sales.yaml",
    "src/checkout.test.ts",
    "src/stock-policy.ts",
    ".invariant/sabotages/sales/stock.ts",
  ];
  const files: Record<string, string> = {};
  for (const name of names) {
    files[name] = await readFile(fixtureFile("healthy-registry", name), "utf8");
  }
  return files;
}

/** The two immutability cases need real git history; everything else is a copy-and-run. */
async function runGitRuleChange(name: string, expected: Expected): Promise<void> {
  const { root, baseSha } = await makeGitRepo(await healthyFiles());
  const rule = await readFile(path.join(root, "rules/sales.yaml"), "utf8");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    path.join(root, "rules/sales.yaml"),
    rule.replace("Prevents overselling.", "Prevents overselling at any price."),
    "utf8",
  );
  await commitAll(root, "amend the rule");

  const run = await spawnCli(
    ["validate", "--base", baseSha, "--event", fixtureFile(name, "event.json")],
    { cwd: root, env: hermeticEnv() },
  );
  expect(run.exitCode).toBe(expected.exit_code);
}

describe("corpus (spec §11)", () => {
  it("every hostile case has a fixture with an expected exit code", async () => {
    for (const name of CASES) {
      expect((await expectedFor(name)).exit_code).toBeGreaterThanOrEqual(0);
    }
  });

  it.each(CASES)("%s", async (name) => {
    const expected = await expectedFor(name);
    if (expected.setup === "git-rule-change") {
      await runGitRuleChange(name, expected);
      return;
    }

    const run = await runFixture(name, { args: expected.args, env: hermeticEnv() });
    expect(run.exitCode).toBe(expected.exit_code);
    if (run.report) {
      await expectGolden(name, normalizeReport(run.report), "report.json");
    }
    if (run.comment) {
      await expectGolden(name, run.comment, "comment.md");
    }
    if (run.doctor) {
      await expectGolden(name, run.doctor, "doctor.json");
    }
  });
});
