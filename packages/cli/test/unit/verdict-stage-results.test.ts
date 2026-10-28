import { describe, expect, it } from "vitest";
import { readStageResults } from "../../src/commands/verdict.js";
import { makeTmpRepo } from "../helpers/fixture.js";

const JOBS = ["invariant-registry", "invariant-checks", "invariant-negative"] as const;
type Job = (typeof JOBS)[number];

/**
 * The artifacts the plan's workflow uploads, per job (plan lines 1189-1191).
 * There is no `stage-result.json`: each job writes its own command's `--json`
 * payload under its own name.
 */
const ARTIFACT: Record<Job, string> = {
  "invariant-registry": "registry-result.json",
  "invariant-checks": "checks-result.json",
  "invariant-negative": "negative-result.json",
};

/** The payload each command's `--json --out` writes, verbatim. */
const PAYLOAD: Record<Job, Record<string, unknown>> = {
  "invariant-registry": { findings: [] },
  "invariant-checks": { checks: [] },
  "invariant-negative": { findings: [] },
};

function artifact(job: Job, payload: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ ...PAYLOAD[job], ...payload }, null, 2)}\n`;
}

/** A valid three-artifact repo; `null` omits one artifact on purpose. */
async function makeInputs(overrides: Partial<Record<Job, string | null>> = {}): Promise<string> {
  const files: Record<string, string> = {};
  for (const job of JOBS) {
    const value = Object.prototype.hasOwnProperty.call(overrides, job) ? overrides[job] : artifact(job);
    if (value !== null && value !== undefined) files[`${job}/${ARTIFACT[job]}`] = value;
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
  it("reads the three real artifacts in job order", async () => {
    const inputs = await makeInputs();
    const read = await readStageResults(inputs, statuses());

    expect(read.findings).toEqual([]);
    expect(read.results.map((result) => result.job)).toEqual([...JOBS]);
    expect(read.results.map((result) => result.stage)).toEqual(["registry", "checks", "negative"]);
    expect(read.results[0]?.findings).toEqual([]);
    expect(read.results[1]?.checks).toEqual([]);
    expect(read.results[2]?.findings).toEqual([]);
    expect(read.results[2]?.negative).toBeUndefined();
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

  it("reports a failed registry job as upstream.job_failed", async () => {
    const inputs = await makeInputs();
    const read = await readStageResults(inputs, statuses({ "invariant-registry": "failure" }));

    expect(codes(read.findings)).toEqual(["upstream.job_failed"]);
    expect(read.findings[0]?.message).toContain("invariant-registry");
  });

  it("reports a failed negative job as upstream.job_failed", async () => {
    const inputs = await makeInputs();
    const read = await readStageResults(inputs, statuses({ "invariant-negative": "failure" }));

    expect(codes(read.findings)).toEqual(["upstream.job_failed"]);
    expect(read.findings[0]?.message).toContain("invariant-negative");
  });

  it("accepts a failed checks job whose artifact shows a non-pass outcome", async () => {
    // `run` exits 1 when a check is not `pass`, so the job status cannot be the
    // gate decision; the artifact is — but only when it explains the failure.
    const inputs = await makeInputs({
      "invariant-checks": artifact("invariant-checks", {
        checks: [{ runtimeId: "t", outcome: "fail" }],
      }),
    });
    const read = await readStageResults(inputs, statuses({ "invariant-checks": "failure" }));

    expect(read.findings).toEqual([]);
    expect(read.results.find((result) => result.stage === "checks")?.checks).toEqual([
      { runtimeId: "t", outcome: "fail" },
    ]);
  });

  it("rejects a failed checks job whose artifact is all-green as unexplained", async () => {
    const inputs = await makeInputs({
      "invariant-checks": artifact("invariant-checks", {
        checks: [{ runtimeId: "t", outcome: "pass" }],
      }),
    });
    const read = await readStageResults(inputs, statuses({ "invariant-checks": "failure" }));

    expect(codes(read.findings)).toEqual(["upstream.job_failed"]);
    expect(read.findings[0]?.message).toContain("invariant-checks");
    expect(read.findings[0]?.message).toContain("unexplained");
    // An unexplained artifact is not a usable observation.
    expect(read.results.map((result) => result.stage)).not.toContain("checks");
  });

  it("requires an artifact from a failed checks job and reports the missing artifact too", async () => {
    const inputs = await makeInputs({ "invariant-checks": null });
    const read = await readStageResults(inputs, statuses({ "invariant-checks": "failure" }));

    expect(codes(read.findings)).toEqual(["upstream.job_failed", "upstream.artifact_missing"]);
    expect(read.findings[0]?.file).toBe("invariant-checks/checks-result.json");
    expect(read.findings[1]?.message).toBe("artifact not found");
  });

  it("never reads an artifact for a non-success job, even a malformed one", async () => {
    // A cancelled job is not additionally required to have an artifact.
    const inputs = await makeInputs({ "invariant-registry": "{ not json" });
    const read = await readStageResults(inputs, statuses({ "invariant-registry": "cancelled" }));

    expect(codes(read.findings)).toEqual(["upstream.job_cancelled"]);
  });

  it("requires an artifact from a success job and names the real file", async () => {
    const inputs = await makeInputs({ "invariant-registry": null });
    const read = await readStageResults(inputs, statuses());

    expect(codes(read.findings)).toEqual(["upstream.artifact_missing"]);
    expect(read.findings[0]?.file).toBe("invariant-registry/registry-result.json");
    expect(read.findings[0]?.message).toBe("artifact not found");
  });

  it("treats unparseable JSON as a missing artifact and names the parse problem", async () => {
    const inputs = await makeInputs({ "invariant-checks": "{ not json" });
    const read = await readStageResults(inputs, statuses());

    expect(codes(read.findings)).toEqual(["upstream.artifact_missing"]);
    expect(read.findings[0]?.message).toContain("not valid JSON");
  });

  it("rejects a payload that is not the stage's own shape", async () => {
    // A checks payload in the registry slot: nothing produces this, and a
    // finding list cannot be inferred from it.
    const inputs = await makeInputs({ "invariant-registry": artifact("invariant-checks") });
    const read = await readStageResults(inputs, statuses());

    expect(codes(read.findings)).toEqual(["upstream.artifact_missing"]);
    expect(read.findings[0]?.message).toContain("findings is not an array");
  });

  it("rejects a checks payload with no checks array", async () => {
    const inputs = await makeInputs({ "invariant-checks": `${JSON.stringify({ findings: [] })}\n` });
    const read = await readStageResults(inputs, statuses());

    expect(codes(read.findings)).toEqual(["upstream.artifact_missing"]);
    expect(read.findings[0]?.message).toContain("checks is not an array");
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

  it("rejects a finding without a file as a shape mismatch", async () => {
    const inputs = await makeInputs({
      "invariant-registry": artifact("invariant-registry", {
        findings: [{ code: "registry.invalid_id", message: "bad id" }],
      }),
    });
    const read = await readStageResults(inputs, statuses());

    expect(codes(read.findings)).toEqual(["upstream.artifact_missing"]);
    expect(read.findings[0]?.message).toContain("findings[0].file is not a string");
  });

  it("propagates the registry artifact's findings", async () => {
    const finding = { code: "registry.invalid_id", message: "bad id", file: "rules/sales.yaml" };
    const inputs = await makeInputs({
      "invariant-registry": artifact("invariant-registry", { findings: [finding] }),
    });
    const read = await readStageResults(inputs, statuses());

    expect(read.findings).toEqual([finding]);
  });

  it("propagates the negative artifact's flat findings (negative --json)", async () => {
    const finding = { code: "negative.sabotage_missing", message: "missing", file: "rules/flows/x.yaml" };
    const inputs = await makeInputs({
      "invariant-negative": artifact("invariant-negative", { findings: [finding] }),
    });
    const read = await readStageResults(inputs, statuses());

    expect(read.findings).toEqual([finding]);
  });

  it("accepts the extended negative payload and records declared/executed/outcomes", async () => {
    const inputs = await makeInputs({
      "invariant-negative": artifact("invariant-negative", { declared: 2, executed: true, outcomes: {} }),
    });
    const read = await readStageResults(inputs, statuses());

    expect(read.findings).toEqual([]);
    expect(read.results[2]?.negative).toEqual({
      declared: 2,
      executed: true,
      outcomes: {},
      findings: [],
    });
  });

  it("accepts a failed negative job whose artifact reports executed: true", async () => {
    const inputs = await makeInputs({
      "invariant-negative": artifact("invariant-negative", {
        declared: 1,
        executed: true,
        outcomes: { "sales.a": { status: "applied", classification: "assertion" } },
      }),
    });
    const read = await readStageResults(inputs, statuses({ "invariant-negative": "failure" }));

    expect(read.findings).toEqual([]);
    expect(read.results.find((result) => result.stage === "negative")?.negative).toMatchObject({
      executed: true,
    });
  });

  it("rejects an applied outcome with an unknown classification", async () => {
    const inputs = await makeInputs({
      "invariant-negative": artifact("invariant-negative", {
        declared: 1,
        executed: true,
        outcomes: { "sales.a": { status: "applied", classification: "boom" } },
      }),
    });
    const read = await readStageResults(inputs, statuses());

    expect(codes(read.findings)).toEqual(["upstream.artifact_missing"]);
    expect(read.findings[0]?.message).toContain("classification");
  });

  it("rejects a negative payload where declared and executed disagree on presence", async () => {
    const inputs = await makeInputs({
      "invariant-negative": artifact("invariant-negative", { declared: 2 }),
    });
    const read = await readStageResults(inputs, statuses());

    expect(codes(read.findings)).toEqual(["upstream.artifact_missing"]);
    expect(read.findings[0]?.message).toContain("executed");
  });

  it("does not propagate the checks artifact's findings", async () => {
    const inputs = await makeInputs({
      "invariant-checks": artifact("invariant-checks", {
        findings: [{ code: "adapter.broken", message: "x", file: "x" }],
      }),
    });
    const read = await readStageResults(inputs, statuses());

    expect(read.findings).toEqual([]);
  });
});
