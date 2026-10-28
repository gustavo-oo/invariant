import { describe, expect, it } from "vitest";
import { readStageResults } from "../../src/commands/verdict.js";
import { makeTmpRepo } from "../helpers/fixture.js";

const JOBS = ["invariant-registry", "invariant-checks", "invariant-negative"] as const;
type Job = (typeof JOBS)[number];

const STAGE: Record<Job, string> = {
  "invariant-registry": "registry",
  "invariant-checks": "checks",
  "invariant-negative": "negative",
};

function artifact(job: Job, extra: Record<string, unknown> = {}, exitCode = 0): string {
  return `${JSON.stringify(
    { stage: STAGE[job], job, exit_code: exitCode, findings: [], ...extra },
    null,
    2,
  )}\n`;
}

/** A valid three-artifact repo; `null` omits one artifact on purpose. */
async function makeInputs(overrides: Partial<Record<Job, string | null>> = {}): Promise<string> {
  const files: Record<string, string> = {};
  for (const job of JOBS) {
    const value = Object.prototype.hasOwnProperty.call(overrides, job) ? overrides[job] : artifact(job);
    if (value !== null && value !== undefined) files[`${job}/stage-result.json`] = value;
  }
  return await makeTmpRepo(files);
}

function statuses(overrides: Partial<Record<Job, string | undefined>> = {}): Map<string, string> {
  const map = new Map<string, string>();
  for (const job of JOBS) {
    const value = Object.prototype.hasOwnProperty.call(overrides, job) ? overrides[job] : "success";
    if (value !== undefined) map.set(job, value);
  }
  return map;
}

const codes = (findings: Array<{ code: string }>): string[] => findings.map((finding) => finding.code);

describe("readStageResults", () => {
  it("reads all three success artifacts in job order", async () => {
    const inputs = await makeInputs();
    const read = await readStageResults(inputs, statuses());

    expect(read.findings).toEqual([]);
    expect(read.results.map((result) => result.job)).toEqual([...JOBS]);
  });

  it("reports a job with no --job-status entry as missing", async () => {
    const inputs = await makeInputs();
    const read = await readStageResults(inputs, statuses({ "invariant-registry": undefined }));

    expect(codes(read.findings)).toEqual(["upstream.job_missing"]);
    expect(read.findings[0]?.message).toContain("invariant-registry");
    expect(read.results.map((result) => result.job)).toEqual(["invariant-checks", "invariant-negative"]);
  });

  it("reports cancelled and skipped jobs by their own codes", async () => {
    const inputs = await makeInputs();
    const read = await readStageResults(
      inputs,
      statuses({ "invariant-registry": "cancelled", "invariant-checks": "skipped" }),
    );

    expect(codes(read.findings)).toEqual(["upstream.job_cancelled", "upstream.job_skipped"]);
    expect(read.results.map((result) => result.job)).toEqual(["invariant-negative"]);
  });

  it("reports failure as upstream.job_failed", async () => {
    const inputs = await makeInputs();
    const read = await readStageResults(inputs, statuses({ "invariant-checks": "failure" }));

    expect(codes(read.findings)).toEqual(["upstream.job_failed"]);
    expect(read.findings[0]?.message).toContain("invariant-checks");
  });

  it("reports any other non-success status as upstream.job_failed, naming it", async () => {
    const inputs = await makeInputs();
    const read = await readStageResults(inputs, statuses({ "invariant-negative": "timed_out" }));

    expect(codes(read.findings)).toEqual(["upstream.job_failed"]);
    expect(read.findings[0]?.message).toContain("timed_out");
  });

  it("never reads an artifact for a non-success job, even a malformed one", async () => {
    // A cancelled job is not additionally required to have an artifact.
    const inputs = await makeInputs({ "invariant-registry": "{ not json" });
    const read = await readStageResults(inputs, statuses({ "invariant-registry": "cancelled" }));

    expect(codes(read.findings)).toEqual(["upstream.job_cancelled"]);
  });

  it("requires an artifact from a success job and says it was not found", async () => {
    const inputs = await makeInputs({ "invariant-checks": null });
    const read = await readStageResults(inputs, statuses());

    expect(codes(read.findings)).toEqual(["upstream.artifact_missing"]);
    expect(read.findings[0]?.file).toBe("invariant-checks/stage-result.json");
    expect(read.findings[0]?.message).toBe("artifact not found");
  });

  it("treats unparseable JSON as a missing artifact and names the parse problem", async () => {
    const inputs = await makeInputs({ "invariant-checks": "{ not json" });
    const read = await readStageResults(inputs, statuses());

    expect(codes(read.findings)).toEqual(["upstream.artifact_missing"]);
    expect(read.findings[0]?.message).toContain("not valid JSON");
  });

  it("rejects an artifact whose stage disagrees with its directory", async () => {
    const inputs = await makeInputs({
      "invariant-checks": `${JSON.stringify({
        stage: "registry",
        job: "invariant-checks",
        exit_code: 0,
        findings: [],
      })}\n`,
    });
    const read = await readStageResults(inputs, statuses());

    expect(codes(read.findings)).toEqual(["upstream.artifact_missing"]);
    expect(read.findings[0]?.message).toContain('stage is "registry", expected "checks"');
  });

  it("rejects an artifact whose job disagrees with its directory", async () => {
    const inputs = await makeInputs({
      "invariant-negative": artifact("invariant-checks"),
    });
    const read = await readStageResults(inputs, statuses());

    expect(codes(read.findings)).toEqual(["upstream.artifact_missing"]);
    expect(read.findings[0]?.message).toContain(
      'job is "invariant-checks", expected "invariant-negative"',
    );
  });

  it("propagates a registry artifact's findings and does not add job_failed", async () => {
    const finding = { code: "registry.invalid_id", message: "bad id", file: "rules/sales.yaml" };
    const inputs = await makeInputs({
      "invariant-registry": artifact("invariant-registry", { findings: [finding] }, 2),
    });
    const read = await readStageResults(inputs, statuses());

    expect(read.findings).toHaveLength(1);
    expect(read.findings[0]).toMatchObject(finding);
  });

  it("propagates the negative artifact's negative.findings, not its top-level findings", async () => {
    const nested = { code: "negative.sabotage_missing", message: "missing", file: "rules/flows/x.yaml" };
    const inputs = await makeInputs({
      "invariant-negative": artifact(
        "invariant-negative",
        {
          findings: [{ code: "negative.top_level", message: "ignored", file: "x" }],
          negative: { declared: 1, executed: false, findings: [nested] },
        },
        2,
      ),
    });
    const read = await readStageResults(inputs, statuses());

    expect(read.findings).toEqual([nested]);
  });

  it("adds upstream.job_failed for a non-zero artifact with nothing propagated", async () => {
    const inputs = await makeInputs({ "invariant-negative": artifact("invariant-negative", {}, 1) });
    const read = await readStageResults(inputs, statuses());

    expect(codes(read.findings)).toEqual(["upstream.job_failed"]);
    expect(read.findings[0]?.message).toContain("negative");
  });

  it("does not propagate a checks artifact's findings; a non-zero exit still fails", async () => {
    const inputs = await makeInputs({
      "invariant-checks": artifact(
        "invariant-checks",
        { findings: [{ code: "adapter.broken", message: "x", file: "x" }], checks: [] },
        2,
      ),
    });
    const read = await readStageResults(inputs, statuses());

    expect(codes(read.findings)).toEqual(["upstream.job_failed"]);
  });

  it("rejects a checks entry with an unknown outcome as a shape mismatch", async () => {
    const inputs = await makeInputs({
      "invariant-checks": artifact("invariant-checks", {
        checks: [{ runtimeId: "t", outcome: "green" }],
      }),
    });
    const read = await readStageResults(inputs, statuses());

    expect(codes(read.findings)).toEqual(["upstream.artifact_missing"]);
    expect(read.findings[0]?.message).toContain("checks[0].outcome");
  });
});
