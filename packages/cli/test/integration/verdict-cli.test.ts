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

/**
 * One worker's real `--json --out` payload. There is no wrapper envelope: the
 * job directory and the file name carry the job and the stage.
 */
function artifact(engine: "registry" | "checks" | "negative", payload: Record<string, unknown> = {}): string {
  const base = engine === "checks" ? { checks: [] } : { findings: [] };
  return JSON.stringify({ ...base, ...payload }, null, 2);
}

/** A repo whose three upstream artifacts are all present and green. */
async function makeVerdictRepo(
  checksOutcome: "pass" | "fail" | "not-run",
  extra: Record<string, string> = {},
  omitted: Array<"registry" | "checks" | "negative"> = [],
): Promise<string> {
  const files: Record<string, string> = {
    "rules/sales.yaml": RULES,
    "src/sales.test.ts": TEST,
    "inputs/invariant-registry/registry-result.json": artifact("registry"),
    "inputs/invariant-checks/checks-result.json": artifact("checks", {
      checks: [{ runtimeId: RUNTIME_ID, outcome: checksOutcome }],
    }),
    "inputs/invariant-negative/negative-result.json": artifact("negative", {
      declared: 1,
      executed: false,
    }),
    ...extra,
  };
  for (const job of omitted) {
    delete files[
      job === "registry"
        ? "inputs/invariant-registry/registry-result.json"
        : job === "checks"
          ? "inputs/invariant-checks/checks-result.json"
          : "inputs/invariant-negative/negative-result.json"
    ];
  }
  return await makeTmpRepo(files);
}

/**
 * The plan's flat `DoctorResult` (plan line 1371): there is no `doctor`
 * envelope, the observation carries its own availability, and each finding
 * carries a severity the class decision filters on.
 */
function doctorArtifact(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
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
      ...overrides,
    },
    null,
    2,
  );
}

const DOCTOR = doctorArtifact();

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

  it("is exit 1, not a gate failure, when the checks job failed but its artifact is readable", async () => {
    // `run` exits 1 exactly when a check is not `pass`, so CI reports the
    // checks job as `failure` for a red product. The artifact — not the job
    // status — decides the product verdict.
    const root = await makeVerdictRepo("fail");
    const run = await spawnCli(
      [
        "verdict",
        "--inputs",
        "inputs",
        "--job-status",
        "invariant-registry=success",
        "--job-status",
        "invariant-checks=failure",
        "--job-status",
        "invariant-negative=success",
      ],
      { cwd: root },
    );

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("G3 product broken\n");
    const report = await readReportFile(root);
    expect(report.exit_code).toBe(1);
    expect(report.integrity).toEqual([]);
    expect(report.rules.map((rule) => [rule.rule_id, rule.verdict])).toEqual([["SALES-004", "fail"]]);
  });

  it("is a gate failure when the checks job failed and left no artifact", async () => {
    const root = await makeVerdictRepo("fail", {}, ["checks"]);
    const run = await spawnCli(
      [
        "verdict",
        "--inputs",
        "inputs",
        "--job-status",
        "invariant-registry=success",
        "--job-status",
        "invariant-checks=failure",
        "--job-status",
        "invariant-negative=success",
      ],
      { cwd: root },
    );

    expect(run.exitCode).toBe(2);
    const report = await readReportFile(root);
    expect(report.integrity.map((finding) => finding.code)).toContain("upstream.artifact_missing");
  });

  it("rejects a duplicate --job-status for one job instead of letting the last entry win", async () => {
    // `--job-status invariant-checks=cancelled --job-status
    // invariant-checks=success` must never turn a cancelled job green.
    const root = await makeVerdictRepo("pass");
    const run = await spawnCli(
      [
        "verdict",
        "--inputs",
        "inputs",
        "--job-status",
        "invariant-registry=success",
        "--job-status",
        "invariant-checks=cancelled",
        "--job-status",
        "invariant-checks=success",
        "--job-status",
        "invariant-negative=success",
      ],
      { cwd: root },
    );

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("G3 gate broken\n");
    const report = await readReportFile(root);
    expect(report.exit_code).toBe(2);
    const duplicate = report.integrity.find(
      (finding) => finding.code === "upstream.job_status_duplicate",
    );
    expect(duplicate?.message).toContain("invariant-checks");
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

  it("is a gate failure when discovery cannot run, and publishes no product verdicts", async () => {
    const root = await makeVerdictRepo("pass", {
      ".invariant/config.yaml": "adapter: no-such-adapter\n",
    });
    const run = await spawnCli(["verdict", "--inputs", "inputs", ...GREEN_STATUSES], { cwd: root });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("G3 gate broken\n");
    const report = await readReportFile(root);
    expect(report.exit_code).toBe(2);
    expect(report.integrity.map((finding) => finding.code)).toContain("integrity.discovery_error");
    // A discovery failure is a gate problem, never a verdict about the product:
    // no rule may be published as `rule_no_check` (or as anything else).
    expect(report.checks).toEqual([]);
    expect(report.rules).toEqual([]);
    expect(report.flows).toEqual([]);
    const comment = await readFile(path.join(root, "invariant-comment.md"), "utf8");
    expect(comment).not.toContain("rule_no_check");
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

  it("reaches G1 from a plan-shaped artifact with an available observation and no fail findings", async () => {
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

  it("keeps G1 when the doctor result carries only info-severity findings", async () => {
    const root = await makeVerdictRepo("pass", {
      "doctor.json": doctorArtifact({
        findings: [
          {
            code: "merge_queue.workflow_missing_trigger",
            severity: "info",
            message: "merge_queue: unknown",
          },
        ],
      }),
    });
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
    const report = await readReportFile(root);
    expect(report.guarantee.class).toBe("G1");
    // Only fail-severity findings reach the class decision, so the summary does
    // not turn an informational observation into a protection problem.
    expect(report.guarantee.doctor.findings).toEqual([]);
  });

  it("lowers the class for a fail-severity doctor finding and reports it", async () => {
    const root = await makeVerdictRepo("pass", {
      "doctor.json": doctorArtifact({
        findings: [
          { code: "protection.missing", severity: "fail", message: "main is unprotected" },
        ],
      }),
    });
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
    const report = await readReportFile(root);
    expect(report.guarantee.class).toBe("G3");
    expect(report.guarantee.doctor).toMatchObject({
      ran: true,
      observation: "available",
      findings: [{ code: "protection.missing", message: "main is unprotected" }],
    });
  });

  it("never claims G1 from a doctor result when no --repo/--run-id expectation was supplied", async () => {
    const root = await makeVerdictRepo("pass", { "doctor.json": DOCTOR });
    const run = await spawnCli(
      ["verdict", "--inputs", "inputs", "--doctor-result", "doctor.json", ...GREEN_STATUSES],
      { cwd: root },
    );

    // The product is green; the observation cannot be attributed to this run, so
    // the class is G3 and the reason is on the report rather than a silent G1.
    expect(run.exitCode).toBe(0);
    const report = await readReportFile(root);
    expect(report.guarantee.class).toBe("G3");
    expect(report.guarantee.binding).toBe(false);
    expect(report.guarantee.doctor).toMatchObject({ ran: false, observation: "unavailable" });
    const mismatch = report.integrity.find((finding) => finding.code === "doctor.result_mismatch");
    expect(mismatch?.message).toContain("--repo");
    expect(mismatch?.message).toContain("--run-id");
  });

  it("never claims G1 when the doctor result belongs to another run", async () => {
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
        "41",
        ...GREEN_STATUSES,
      ],
      { cwd: root },
    );

    expect(run.exitCode).toBe(0);
    const report = await readReportFile(root);
    expect(report.guarantee.class).toBe("G3");
    expect(report.guarantee.doctor).toMatchObject({ ran: false, observation: "unavailable" });
    const mismatch = report.integrity.find((finding) => finding.code === "doctor.result_mismatch");
    expect(mismatch?.message).toContain("run_id");
    expect(mismatch?.message).toContain('"41"');
  });

  it("rejects the invented nested doctor envelope as unusable and never claims G1", async () => {
    const root = await makeVerdictRepo("pass", {
      "doctor.json": JSON.stringify({
        repo: "acme/shop",
        run_id: "42",
        doctor: {
          ran: true,
          class: "G1",
          reasons: [],
          findings: [],
          observation: "available",
        },
      }),
    });
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
    const report = await readReportFile(root);
    expect(report.guarantee.class).toBe("G3");
    expect(report.guarantee.doctor).toMatchObject({ ran: false, observation: "unavailable" });
    expect(report.integrity.map((finding) => finding.code)).toContain("doctor.result_mismatch");
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
