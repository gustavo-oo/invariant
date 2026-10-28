import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { commitAll, makeGitRepo, makeTmpRepo } from "../helpers/fixture.js";
import { expectGolden, normalizeReport } from "../helpers/goldens.js";
import { linkNodeModules } from "../helpers/node-modules.js";
import { capability } from "../helpers/registry.js";
import { runFixture, spawnCli } from "../helpers/run-cli.js";

/**
 * The integration tests always spawn the CLI with the ambient GitHub run
 * context removed. `verify` reads `GITHUB_EVENT_PATH`/`GITHUB_REPOSITORY`/
 * `GITHUB_RUN_ID` by contract (ruling 10), and a developer shell or an Actions
 * step sets them; without this the report's `inputs` — and therefore the
 * golden — would change from host to host.
 */
function hermeticEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["GITHUB_EVENT_PATH", "GITHUB_REPOSITORY", "GITHUB_RUN_ID"]) delete env[name];
  return env;
}

const FIXTURE = fileURLToPath(new URL("../fixtures/healthy-registry/", import.meta.url));
const PR_EVENT = fileURLToPath(new URL("../fixtures/rule-changed-in-feature-pr/event.json", import.meta.url));

/** The healthy fixture's own files, read as a map so a git repo can be built from them. */
async function healthyFiles(): Promise<Record<string, string>> {
  const names = [
    "rules/sales.yaml",
    "src/checkout.test.ts",
    "src/stock-policy.ts",
    ".invariant/sabotages/sales/stock.ts",
  ];
  const files: Record<string, string> = {};
  for (const name of names) files[name] = await readFile(path.join(FIXTURE, name), "utf8");
  return files;
}

/**
 * The plan's flat `DoctorResult` (plan line 1371): no nested envelope, the
 * observation carries its own availability, and findings carry a severity.
 */
const DOCTOR = JSON.stringify(
  {
    schema_version: 1,
    repo: "acme/shop",
    run_id: "42",
    class: "G1",
    reasons: [],
    findings: [],
    observation: {
      available: true,
      repo: { owner: "acme", name: "shop", defaultBranch: "main", visibility: "public" },
      protection: {
        mechanism: "ruleset",
        requiredContexts: [{ context: "invariant-verdict", appId: 15368 }],
        codeOwnerReview: true,
        bypassActors: [],
        mergeQueue: "unknown",
      },
    },
  },
  null,
  2,
);

describe("invariant verify", () => {
  it("exits 0 and writes report + comment for a healthy registry", async () => {
    const run = await runFixture("healthy-registry", { args: ["verify"], env: hermeticEnv() });

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    // R65: the summary counts enforced rules only.
    expect(run.stdout).toBe("1 rules green, 0 not green, class G3, negative control declared-only\n");
    await expectGolden("healthy-registry", normalizeReport(run.report!), "report.json");
    await expectGolden("healthy-registry", run.comment!, "comment.md");
  });

  it("exits 1 when a check is flaky per the read report", async () => {
    const run = await runFixture("flaky-check", {
      args: ["verify", "--reports", "reports/vitest.json"],
      env: hermeticEnv(),
    });

    expect(run.exitCode).toBe(1);
    expect(run.report?.rules[0]?.verdict).toBe("flaky");
    await expectGolden("flaky-check", run.stdout, "stdout.txt");
  });

  it("consumes each report result once when two checks share a runtimeId (R35)", async () => {
    // src/a.test.ts passes and src/b.test.ts fails, but both carry the same
    // runtimeId. A first-match lookup would green both checks and exit 0.
    const run = await runFixture("duplicate-runtime-id", {
      args: ["verify", "--reports", "reports/vitest.json"],
      env: hermeticEnv(),
    });

    expect(run.exitCode).toBe(1);
    expect(run.report?.checks.map((check) => check.verdict).sort()).toEqual(["fail", "pass"]);
    expect(run.report?.rules[0]?.verdict).toBe("fail");
  });

  it("does not gate a failing check under a draft rule (spec §5.3)", async () => {
    const root = await makeTmpRepo({
      "rules/sales.yaml": capability("SALES-004", { status: "draft" }),
      "src/sales.test.ts": `import { describe, test } from "vitest";\n\ndescribe("sales", () => {\n  // @check sales.rejects-insufficient-stock\n  // @rule SALES-004\n  test("rejects insufficient stock", () => {});\n});\n`,
      "reports/vitest.json": JSON.stringify({
        testResults: [
          {
            name: "src/sales.test.ts",
            assertionResults: [
              {
                fullName: "sales rejects insufficient stock",
                ancestorTitles: ["sales"],
                title: "rejects insufficient stock",
                status: "failed",
              },
            ],
          },
        ],
      }),
    });

    const run = await spawnCli(["verify", "--reports", "reports/vitest.json"], {
      cwd: root,
      env: hermeticEnv(),
    });
    expect(run.exitCode).toBe(0);

    const report = JSON.parse(
      await readFile(path.join(root, "invariant-report.json"), "utf8"),
    ) as { rules: Array<{ rule_id: string; status: string; verdict: string }> };
    expect(report.rules.find((rule) => rule.rule_id === "SALES-004")).toMatchObject({
      status: "draft",
      verdict: "fail",
    });
  });

  it("lets a gate failure outrank a product failure (2 > 1)", async () => {
    const flaky = await runFixture("flaky-check", {
      args: ["verify", "--reports", "reports/vitest.json"],
      env: hermeticEnv(),
    });
    expect(flaky.exitCode).toBe(1);
    await writeFile(path.join(flaky.root, "baseline.json"), JSON.stringify({ recorded_class: "G1" }), "utf8");

    const run = await spawnCli(
      ["verify", "--reports", "reports/vitest.json", "--baseline", "baseline.json"],
      { cwd: flaky.root, env: hermeticEnv() },
    );
    expect(run.exitCode).toBe(2);

    const report = JSON.parse(
      await readFile(path.join(flaky.root, "invariant-report.json"), "utf8"),
    ) as { integrity: Array<{ code: string }>; rules: Array<{ verdict: string }> };
    expect(report.integrity.map((finding) => finding.code)).toContain("baseline.regressed");
    expect(report.rules[0]?.verdict).toBe("flaky");
  });

  it("gates a supplied but unreadable event even without --base (R58)", async () => {
    const healthy = await runFixture("healthy-registry", { args: ["verify"], env: hermeticEnv() });
    await writeFile(path.join(healthy.root, "bad-event.json"), "{ not json", "utf8");

    const run = await spawnCli(["verify", "--event", "bad-event.json"], {
      cwd: healthy.root,
      env: hermeticEnv(),
    });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("ci.event_unreadable");

    const report = JSON.parse(
      await readFile(path.join(healthy.root, "invariant-report.json"), "utf8"),
    ) as { integrity: Array<{ code: string }>; rules: Array<{ verdict: string }> };
    expect(report.integrity.map((finding) => finding.code)).toContain("ci.event_unreadable");
    // The product itself is still evaluated and stays green.
    expect(report.rules.map((rule) => rule.verdict)).toEqual(["pass"]);
  });

  it("resolves --baseline and --doctor-result against the CLI cwd, not --root", async () => {
    const healthy = await runFixture("healthy-registry", { args: ["verify"], env: hermeticEnv() });
    const cwd = await makeTmpRepo({
      "baseline.json": JSON.stringify({ recorded_class: "G1" }),
      "doctor.json": DOCTOR,
    });

    const run = await spawnCli(
      [
        "verify",
        "--root",
        healthy.root,
        "--baseline",
        "baseline.json",
        "--doctor-result",
        "doctor.json",
        "--repo",
        "acme/shop",
        "--run-id",
        "42",
      ],
      { cwd, env: hermeticEnv() },
    );

    // Both artifacts are in the cwd. Reading them from --root would make the
    // baseline unreadable and the doctor unverifiable, so this cannot pass by
    // accident.
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("class G1");
  });

  it("never claims G1 without a doctor result and records declared-only negative control", async () => {
    const run = await runFixture("healthy-registry", { args: ["verify"], env: hermeticEnv() });

    expect(run.report?.guarantee.class).toBe("G3");
    expect(run.report?.guarantee.negative_control).toBe("declared-only");
    expect(run.report?.rules.every((rule) => rule.sabotage_verified === false)).toBe(true);
  });

  it("emits no rule verdicts when stage 1 fails (R63)", async () => {
    const run = await runFixture("invalid-registry", { args: ["verify"], env: hermeticEnv() });

    expect(run.exitCode).toBe(2);
    expect(run.report?.checks).toEqual([]);
    expect(run.report?.rules).toEqual([]);
    expect(run.report?.flows).toEqual([]);
    expect(run.report?.integrity.length).toBeGreaterThan(0);
    // The comment says why the gate is red instead of rendering an all-green table.
    expect(run.comment).toContain("### Gate failures");
    expect(run.comment).not.toContain("No enforced rules are declared");
  });

  it("gates a class regression against the recorded baseline, and never ignores a malformed one (R62)", async () => {
    const healthy = await runFixture("healthy-registry", { args: ["verify"], env: hermeticEnv() });
    await writeFile(path.join(healthy.root, "baseline.json"), JSON.stringify({ recorded_class: "G1" }), "utf8");

    const regressed = await spawnCli(["verify", "--baseline", "baseline.json"], {
      cwd: healthy.root,
      // Ruling 10: absent flags, the report's repo/run_id come from the run env.
      env: { ...hermeticEnv(), GITHUB_REPOSITORY: "env/repo", GITHUB_RUN_ID: "99" },
    });
    expect(regressed.exitCode).toBe(2);
    expect(regressed.stdout).toContain("class G3");
    const report = JSON.parse(
      await readFile(path.join(healthy.root, "invariant-report.json"), "utf8"),
    ) as {
      inputs: { repo: string | null; run_id: string | null };
      integrity: Array<{ code: string }>;
    };
    expect(report.integrity.map((finding) => finding.code)).toContain("baseline.regressed");
    expect(report.inputs).toMatchObject({ repo: "env/repo", run_id: "99" });

    await writeFile(path.join(healthy.root, "baseline.json"), JSON.stringify({ recorded_class: "G0" }), "utf8");
    const malformed = await spawnCli(["verify", "--baseline", "baseline.json"], {
      cwd: healthy.root,
      env: hermeticEnv(),
    });
    expect(malformed.exitCode).toBe(2);
    expect(malformed.stderr).toContain("baseline.unreadable");
  });

  it("falls back to executing when the requested report cannot be read (Task 6)", async () => {
    const run = await runFixture("healthy-registry", {
      args: ["verify", "--reports", "reports/does-not-exist.json"],
      env: hermeticEnv(),
    });

    // The check is `pass` only because the suite actually ran: a missing report
    // is never "no checks ran".
    expect(run.exitCode).toBe(0);
    expect(run.report?.checks.map((check) => check.verdict)).toEqual(["pass"]);
  });

  it("reaches G1 from an attributable doctor result, and records the flags as inputs", async () => {
    const healthy = await runFixture("healthy-registry", { args: ["verify"], env: hermeticEnv() });
    await writeFile(path.join(healthy.root, "doctor.json"), DOCTOR, "utf8");

    const run = await spawnCli(
      ["verify", "--doctor-result", "doctor.json", "--repo", "acme/shop", "--run-id", "42"],
      { cwd: healthy.root, env: hermeticEnv() },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("class G1");
    const report = JSON.parse(
      await readFile(path.join(healthy.root, "invariant-report.json"), "utf8"),
    ) as {
      inputs: { repo: string | null; run_id: string | null };
      guarantee: { class: string; doctor: { ran: boolean; observation: string } };
    };
    expect(report.guarantee.class).toBe("G1");
    expect(report.guarantee.doctor).toMatchObject({ ran: true, observation: "available" });
    expect(report.inputs).toMatchObject({ repo: "acme/shop", run_id: "42" });
  });

  it("records a protected-path change under both immutability and integrity and keeps exit 1 (R11)", async () => {
    // The diff needs real history, so the fixture's files are committed here and
    // the rule is amended on top (the same shape as the immutability tests).
    const { root, baseSha } = await makeGitRepo(await healthyFiles());
    await linkNodeModules(root);
    const rule = await readFile(path.join(root, "rules/sales.yaml"), "utf8");
    await writeFile(path.join(root, "rules/sales.yaml"), rule.replace("Prevents overselling.", "Prevents overselling at any price."), "utf8");
    await commitAll(root, "amend the rule");

    const run = await spawnCli(["verify", "--base", baseSha, "--event", PR_EVENT], {
      cwd: root,
      env: hermeticEnv(),
    });

    expect(run.exitCode).toBe(1);
    const report = JSON.parse(await readFile(path.join(root, "invariant-report.json"), "utf8")) as {
      inputs: { mode: string; base: string | null; head: string | null };
      immutability: { protected_paths_changed: string[]; flagged: boolean };
      integrity: Array<{ code: string }>;
      rules: Array<{ verdict: string }>;
    };
    // Ruling 10: the mode comes from the event, not from a hardcoded "push".
    expect(report.inputs).toEqual({ mode: "pr", base: baseSha, head: null, repo: null, run_id: null });
    expect(report.immutability).toEqual({
      protected_paths_changed: ["rules/sales.yaml"],
      flagged: false,
    });
    expect(report.integrity.map((finding) => finding.code)).toContain("immutability.protected_path_changed");
    // The product itself is green: the run is red for immutability, not a rule.
    expect(report.rules.map((rule) => rule.verdict)).toEqual(["pass"]);

    // A diff that cannot be computed is the gate's failure (exit 2), not a red
    // product; the suite still rolls up and the rule stays green.
    const undiffable = await spawnCli(["verify", "--base", "no-such-base", "--event", PR_EVENT], {
      cwd: root,
      env: hermeticEnv(),
    });
    expect(undiffable.exitCode).toBe(2);
    const gateReport = JSON.parse(await readFile(path.join(root, "invariant-report.json"), "utf8")) as {
      integrity: Array<{ code: string }>;
      rules: Array<{ verdict: string }>;
    };
    expect(gateReport.integrity.map((finding) => finding.code)).toContain("immutability.diff_unavailable");
    expect(gateReport.rules.map((rule) => rule.verdict)).toEqual(["pass"]);
  });

  it("exits 2 with no verdicts when the adapter cannot run", async () => {
    // No `node_modules` symlink: the fixture is a repo the adapter cannot
    // execute, which is a gate failure, never "no checks ran".
    const root = await makeTmpRepo(await healthyFiles());
    const run = await spawnCli(["verify"], { cwd: root, env: hermeticEnv() });

    expect(run.exitCode).toBe(2);
    const report = JSON.parse(await readFile(path.join(root, "invariant-report.json"), "utf8")) as {
      integrity: Array<{ code: string; message: string }>;
      checks: unknown[];
      rules: unknown[];
    };
    expect(report.integrity.map((finding) => finding.code)).toContain("adapter.failed");
    expect(report.checks).toEqual([]);
    expect(report.rules).toEqual([]);
    // Ruling 12: the host's install path never reaches the report.
    expect(report.integrity[0]?.message).not.toContain(root);
  });
});
