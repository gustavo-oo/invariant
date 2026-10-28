import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { commitAll, makeGitRepo } from "../helpers/fixture.js";
import { expectGolden } from "../helpers/goldens.js";
import { spawnCli } from "../helpers/run-cli.js";

/**
 * Immutability needs real history: the diff is between two commits, so the
 * repository is built here rather than copied from `test/fixtures` (which only
 * hold the event JSON — the shas are per-run and cannot live in a static
 * fixture). The event deliberately carries no base/head: `--base` supplies the
 * base and the CLI diffs to `HEAD`, so the fixture stays reusable.
 */
const RULE_BEFORE = `capability: sales
rules:
  - id: SALES-004
    statement: "A sale MUST NOT complete when stock is insufficient."
    rationale: "Prevents overselling."
    criticality: critical
    status: enforced
    owners: [team-commerce]
    checks:
      - id: sales.rejects-insufficient-stock
        layer: integration
        negative_control:
          kind: seam
          seam: buildApp({ stockPolicy })
          sabotage: .invariant/sabotages/sales/stock.ts
`;

const CHECK = `import { describe, expect, test } from "vitest";

describe("sales", () => {
  // @check sales.rejects-insufficient-stock
  // @rule SALES-004
  // @negative-control .invariant/sabotages/sales/stock.ts
  test("is rejected when stock is insufficient", () => {
    expect(1 + 1).toBe(2);
  });
});
`;

const eventPath = (name: string): string => fileURLToPath(new URL(`../fixtures/${name}/event.json`, import.meta.url));

/** Base commit with a §5-valid, reconciling registry; then a protected change on top. */
async function repoWithRuleChange(): Promise<{ root: string; baseSha: string }> {
  const { root, baseSha } = await makeGitRepo({
    "rules/sales.yaml": RULE_BEFORE,
    "src/sales.test.ts": CHECK,
    // A later task may check that the declared artifact exists: make the fixture
    // honest now rather than have it break there.
    ".invariant/sabotages/sales/stock.ts": "export const sabotaged = true;\n",
  });
  const amended = RULE_BEFORE.replace("Prevents overselling.", "Prevents overselling at any price.");
  await writeFile(path.join(root, "rules/sales.yaml"), amended, "utf8");
  await commitAll(root, "amend the rule");
  return { root, baseSha };
}

/** A child env with `GITHUB_EVENT_PATH` removed, so "no event" is hermetic. */
function withoutEventPath(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["GITHUB_EVENT_PATH"];
  return env;
}

describe("invariant validate immutability", () => {
  it("exits 1 when a rule changed in a feature PR without the rule-change label", async () => {
    const { root, baseSha } = await repoWithRuleChange();
    const run = await spawnCli(["validate", "--base", baseSha, "--event", eventPath("rule-changed-in-feature-pr")], {
      cwd: root,
    });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("immutability.protected_path_changed");
    await expectGolden("rule-changed-in-feature-pr", run.stdout, "stdout.txt");
  });

  it("exits 0 for the same change when the PR carries the rule-change label", async () => {
    const { root, baseSha } = await repoWithRuleChange();
    const run = await spawnCli(["validate", "--base", baseSha, "--event", eventPath("rule-changed-flagged")], {
      cwd: root,
    });

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    await expectGolden("rule-changed-flagged", run.stdout, "stdout.txt");
  });

  it("does not diff, and stays green, when --base is absent", async () => {
    const { root } = await repoWithRuleChange();
    const run = await spawnCli(["validate", "--event", eventPath("rule-changed-in-feature-pr")], { cwd: root });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("1 enforced rule\n");
    expect(run.stderr).toBe("");
  });

  it("exits 2, not 1, when the diff cannot be computed", async () => {
    const { root } = await repoWithRuleChange();
    const run = await spawnCli(["validate", "--base", "no-such-base", "--event", eventPath("rule-changed-in-feature-pr")], {
      cwd: root,
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("immutability.diff_unavailable");
    expect(run.stderr).not.toContain("immutability.protected_path_changed");
    expect(run.stderr.startsWith("(diff) ")).toBe(true);
    expect(run.stderr).toContain("no-such-base");
    // One finding per line, even when git's stderr is multi-line.
    expect(run.stderr.trimEnd().split("\n")).toHaveLength(1);
  });

  it("treats no event at all as a legitimate local audit: records, never fails", async () => {
    const { root, baseSha } = await repoWithRuleChange();
    const run = await spawnCli(["validate", "--base", baseSha], { cwd: root, env: withoutEventPath() });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("1 enforced rule\n");
    expect(run.stderr).toBe("");
  });

  it("exits 2 when a supplied event cannot be read, instead of silently skipping the check", async () => {
    const { root, baseSha } = await repoWithRuleChange();
    const run = await spawnCli(
      ["validate", "--base", baseSha, "--event", path.join(root, "missing-event.json")],
      { cwd: root, env: withoutEventPath() },
    );

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("ci.event_unreadable");
    expect(run.stderr).not.toContain("immutability.protected_path_changed");
    expect(run.stderr.trimEnd().split("\n")).toHaveLength(1);
  });

  it("emits the immutability finding through --json", async () => {
    const { root, baseSha } = await repoWithRuleChange();
    const run = await spawnCli(
      ["validate", "--base", baseSha, "--event", eventPath("rule-changed-in-feature-pr"), "--json"],
      { cwd: root },
    );

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toBe("");
    const parsed = JSON.parse(run.stdout) as { findings: Array<{ code: string; file: string }> };
    expect(parsed.findings.map((finding) => finding.code)).toEqual(["immutability.protected_path_changed"]);
    expect(parsed.findings[0]?.file).toBe("rules/sales.yaml");
  });
});
