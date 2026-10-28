import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTmpRepo } from "../helpers/fixture.js";
import { expectGolden } from "../helpers/goldens.js";
import { runFixture, spawnCli } from "../helpers/run-cli.js";
import type { Report } from "../../src/report/shape.js";

const RULES = `capability: sales
rules:
  - id: SALES-004
    statement: "A sale MUST NOT complete when stock is insufficient."
    rationale: "Prevents overselling."
    criticality: critical
    status: enforced
    owners: [team-commerce]
    checks:
      - id: sales.rejects-insufficient-stock
        layer: unit
        negative_control:
          kind: seam
          seam: buildApp({ stockPolicy })
          sabotage: .invariant/sabotages/sales/stock.ts
`;

const TEST = `import { test } from "vitest";

// @check sales.rejects-insufficient-stock
// @rule SALES-004
test("is rejected when stock is insufficient", () => {});
`;

const RUNTIME_ID = "is rejected when stock is insufficient";

function stage(
  stageName: "registry" | "checks" | "negative",
  job: string,
  extra: Record<string, unknown> = {},
  exitCode: 0 | 1 | 2 = 0,
): string {
  return JSON.stringify({ stage: stageName, job, exit_code: exitCode, findings: [], ...extra }, null, 2);
}

/** A repo whose three upstream artifacts are all present and green. */
async function makeVerdictRepo(
  checksOutcome: "pass" | "not-run",
  extra: Record<string, string> = {},
): Promise<string> {
  return await makeTmpRepo({
    "rules/sales.yaml": RULES,
    "src/sales.test.ts": TEST,
    "inputs/invariant-registry/stage-result.json": stage("registry", "invariant-registry"),
    "inputs/invariant-checks/stage-result.json": stage("checks", "invariant-checks", {
      checks: [{ runtimeId: RUNTIME_ID, outcome: checksOutcome }],
    }),
    "inputs/invariant-negative/stage-result.json": stage("negative", "invariant-negative", {
      negative: { declared: 1, executed: false, findings: [] },
    }),
    ...extra,
  });
}

const DOCTOR = JSON.stringify({
  repo: "acme/shop",
  run_id: "42",
  doctor: {
    ran: true,
    class: "G1",
    reasons: [],
    findings: [],
    observation: "available",
  },
});

async function readReportFile(root: string): Promise<Report> {
  return JSON.parse(await readFile(path.join(root, "invariant-report.json"), "utf8")) as Report;
}

const GREEN_STATUSES = [
  "--job-status",
  "invariant-registry=success",
  "--job-status",
  "invariant-checks=success",
  "--job-status",
  "invariant-negative=success",
];

describe("invariant verdict", () => {
  it("is red when an upstream job was cancelled, even with a green checks artifact", async () => {
    const run = await runFixture("upstream-cancelled", {
      args: [
        "verdict",
        "--inputs",
        ".",
        "--job-status",
        "invariant-registry=cancelled",
        "--job-status",
        "invariant-checks=success",
        "--job-status",
        "invariant-negative=success",
      ],
    });
    expect(run.exitCode).toBe(2);
    expect(run.report).not.toBeNull();
    expect(run.report?.guarantee.negative_control).toBe("declared-only");
    expect(run.report?.integrity.map((finding) => finding.code)).toContain("upstream.job_cancelled");
    await expectGolden("upstream-cancelled", run.stdout, "stdout.txt");
    await expectGolden("upstream-cancelled", run.comment ?? "", "comment.txt");
  });

  it("is red when a report artifact is absent — never infers success from absence", async () => {
    const run = await runFixture("report-missing", {
      args: ["verdict", "--inputs", ".", "--job-status", "invariant-checks=success"],
    });
    expect(run.exitCode).toBe(2);
    expect(run.report).not.toBeNull();
    expect(run.report?.integrity.map((finding) => finding.code)).toContain("upstream.artifact_missing");
    await expectGolden("report-missing", run.stdout, "stdout.txt");
    await expectGolden("report-missing", run.comment ?? "", "comment.txt");
  });

  it("writes the comment and never calls a G3 run binding", async () => {
    const run = await runFixture("upstream-cancelled", {
      args: [
        "verdict",
        "--inputs",
        ".",
        "--job-status",
        "invariant-registry=cancelled",
        "--job-status",
        "invariant-checks=success",
        "--job-status",
        "invariant-negative=success",
      ],
    });

    expect(run.comment).not.toBeNull();
    expect(run.comment).toContain("G3");
    expect(run.comment).toContain("**No guarantee is claimed by this run.**");
    expect(run.comment).not.toMatch(/binding/i);
    // Exactly one human line, naming the class.
    expect(run.stdout.split("\n").filter((line) => line !== "")).toEqual(["G3 gate broken"]);
  });

  it("is green only when every upstream artifact says every check passed", async () => {
    const root = await makeVerdictRepo("pass");
    const run = await spawnCli(["verdict", "--inputs", "inputs", ...GREEN_STATUSES], { cwd: root });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("G3 green\n");
    expect(run.stderr).toBe("");
    const report = await readReportFile(root);
    expect(report.exit_code).toBe(0);
    expect(report.integrity).toEqual([]);
    expect(report.checks.map((check) => [check.check_id, check.verdict])).toEqual([
      ["sales.rejects-insufficient-stock", "pass"],
    ]);
  });

  it("is exit 1, not green, when the checks artifact carries no result for a discovered check", async () => {
    const root = await makeVerdictRepo("not-run");
    const run = await spawnCli(["verdict", "--inputs", "inputs", ...GREEN_STATUSES], { cwd: root });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("G3 product broken\n");
    const report = await readReportFile(root);
    expect(report.exit_code).toBe(1);
    expect(report.checks.map((check) => check.verdict)).toEqual(["not-run"]);
  });

  it("validates the registry first and writes no report when it is invalid", async () => {
    const run = await runFixture("invalid-registry", {
      args: ["verdict", "--inputs", ".", ...GREEN_STATUSES],
    });

    expect(run.exitCode).toBe(2);
    expect(run.report).toBeNull();
    expect(run.comment).toBeNull();
    expect(run.stderr).not.toBe("");
  });

  it("is a gate failure when discovery cannot run, and still writes the report", async () => {
    const root = await makeVerdictRepo("pass", {
      ".invariant/config.yaml": "adapter: no-such-adapter\n",
    });
    const run = await spawnCli(["verdict", "--inputs", "inputs", ...GREEN_STATUSES], { cwd: root });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("G3 gate broken\n");
    const report = await readReportFile(root);
    expect(report.integrity.map((finding) => finding.code)).toContain("integrity.discovery_error");
  });

  it("gates a class regression against the recorded baseline", async () => {
    const root = await makeVerdictRepo("pass", {
      "baseline.json": JSON.stringify({ recorded_class: "G1" }),
    });
    const run = await spawnCli(
      ["verdict", "--inputs", "inputs", "--baseline", "baseline.json", ...GREEN_STATUSES],
      { cwd: root },
    );

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("G3 gate broken\n");
    const report = await readReportFile(root);
    expect(report.exit_code).toBe(2);
    const regressed = report.integrity.find((finding) => finding.code === "baseline.regressed");
    expect(regressed?.message).toContain("G1");
    expect(regressed?.message).toContain("G3");
  });

  it("does not regress when the run matches its recorded baseline", async () => {
    const root = await makeVerdictRepo("pass", {
      "baseline.json": JSON.stringify({ recorded_class: "G3" }),
    });
    const run = await spawnCli(
      ["verdict", "--inputs", "inputs", "--baseline", "baseline.json", ...GREEN_STATUSES],
      { cwd: root },
    );

    expect(run.exitCode).toBe(0);
    const report = await readReportFile(root);
    expect(report.integrity.map((finding) => finding.code)).not.toContain("baseline.regressed");
  });

  it("treats a doctor envelope mismatch as unverifiable and never claims G1", async () => {
    const root = await makeVerdictRepo("pass", { "doctor.json": DOCTOR });
    const run = await spawnCli(
      [
        "verdict",
        "--inputs",
        "inputs",
        "--doctor-result",
        "doctor.json",
        "--repo",
        "other/repo",
        "--run-id",
        "42",
        ...GREEN_STATUSES,
      ],
      { cwd: root },
    );

    // The product is green; only the observation is unusable, so the class drops
    // to G3 rather than turning the run into a gate failure.
    expect(run.exitCode).toBe(0);
    const report = await readReportFile(root);
    expect(report.guarantee.class).toBe("G3");
    expect(report.guarantee.binding).toBe(false);
    expect(report.guarantee.doctor).toMatchObject({ ran: false, observation: "unavailable" });
    expect(report.integrity.map((finding) => finding.code)).toContain("doctor.result_mismatch");
  });

  it("claims G1 only from a matching, observed doctor result", async () => {
    const root = await makeVerdictRepo("pass", { "doctor.json": DOCTOR });
    const run = await spawnCli(
      [
        "verdict",
        "--inputs",
        "inputs",
        "--doctor-result",
        "doctor.json",
        "--repo",
        "acme/shop",
        "--run-id",
        "42",
        ...GREEN_STATUSES,
      ],
      { cwd: root },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("G1 green\n");
    const report = await readReportFile(root);
    expect(report.guarantee.class).toBe("G1");
    expect(report.guarantee.binding).toBe(true);
    expect(report.guarantee.doctor).toMatchObject({
      ran: true,
      class: "G1",
      observation: "available",
      findings: [],
    });
  });

  it("refuses to run when a requested baseline cannot be read", async () => {
    const root = await makeVerdictRepo("pass");
    const run = await spawnCli(
      ["verdict", "--inputs", "inputs", "--baseline", "missing.json", ...GREEN_STATUSES],
      { cwd: root },
    );

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("cannot read baseline missing.json");
    await expect(readFile(path.join(root, "invariant-report.json"), "utf8")).rejects.toThrow(/ENOENT/);
  });
});
