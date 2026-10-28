import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config } from "../../src/config/model.js";
import {
  readBaseline,
  renderBaseline,
  writeBaseline,
  type Baseline,
} from "../../src/doctor/baseline.js";
import { runDoctorChecks } from "../../src/doctor/checks.js";
import type { GuaranteeClass } from "../../src/guarantee/class.js";
import type { DoctorObservation } from "../../src/seams/forge-probe.js";
import { makeTmpRepo } from "../helpers/fixture.js";

const GOOD_CODEOWNERS = [
  "/rules/ @alice",
  "/.invariant/ @alice",
  "/.github/workflows/invariant.yml @alice",
  "/.github/CODEOWNERS @alice",
].join("\n") + "\n";

const WF = `on:
  pull_request: {}
  merge_group: {}
  workflow_call: {}
jobs:
  invariant-verdict:
    runs-on: ubuntu-latest
`;

const WF_NO_MERGE = `on:
  pull_request: {}
  workflow_call: {}
jobs:
  invariant-verdict:
    runs-on: ubuntu-latest
`;

type Protection = Extract<DoctorObservation, { available: true }>["protection"];

function fullObservation(protection: Partial<Protection> = {}): DoctorObservation {
  return {
    available: true,
    repo: { owner: "o", name: "r", defaultBranch: "main", visibility: "public" },
    protection: {
      mechanism: "ruleset",
      requiredContexts: [{ context: "invariant-verdict", appId: 15368 }],
      codeOwnerReview: true,
      bypassActors: [],
      mergeQueue: "unknown",
      ...protection,
    },
  };
}

function base(expected: Partial<Baseline["expected"]> = {}, recorded: GuaranteeClass = "G1"): Baseline {
  return {
    schema_version: 1,
    recorded_class: recorded,
    expected: {
      required_context: "invariant-verdict",
      required_context_app_id: 15368,
      protected_paths: DEFAULT_CONFIG.protectedPaths,
      bypass_actors: [],
      ...expected,
    },
  };
}

interface Scenario {
  codeowners?: string | null;
  workflows?: Record<string, string>;
  observation?: DoctorObservation;
  baseline?: Baseline;
  config?: Config;
  workflowText?: string;
  workflowFiles?: string[];
}

async function check(scenario: Scenario = {}) {
  const files: Record<string, string> = {
    ".github/workflows/invariant.yml": scenario.workflowText ?? WF,
    ...scenario.workflows,
  };
  if (scenario.codeowners !== null) files[".github/CODEOWNERS"] = scenario.codeowners ?? GOOD_CODEOWNERS;

  const root = await makeTmpRepo(files);
  return runDoctorChecks({
    observation: scenario.observation ?? fullObservation(),
    config: scenario.config ?? DEFAULT_CONFIG,
    baseline: scenario.baseline ?? base(),
    root,
    workflowText: scenario.workflowText ?? WF,
    workflowFiles: scenario.workflowFiles ?? ["invariant.yml"],
  });
}

function codes(result: { findings: Array<{ code: string }> }): string[] {
  return result.findings.map((finding) => finding.code);
}

describe("runDoctorChecks (spec §9.3)", () => {
  it("is G1 when the pinned check, code-owner review, empty bypass and coverage all hold", async () => {
    const result = await check();
    expect(result.class).toBe("G1");
    expect(result.findings.filter((finding) => finding.severity === "fail")).toEqual([]);
  });

  it("is not G1 when the checks are not required", async () => {
    const result = await check({ observation: fullObservation({ requiredContexts: [] }) });
    expect(result.class).not.toBe("G1");
    expect(codes(result)).toContain("protection.no_required_check");
  });

  it("is not G1 when the required check is not pinned to the expected app", async () => {
    const result = await check({
      observation: fullObservation({ requiredContexts: [{ context: "invariant-verdict", appId: null }] }),
    });
    expect(result.class).not.toBe("G1");
    expect(codes(result)).toContain("check.not_pinned_to_app");
  });

  it("is not G1 when a protected path is not covered by code-owner review", async () => {
    const result = await check({
      codeowners: "/.invariant/ @alice\n/.github/workflows/invariant.yml @alice\n/.github/CODEOWNERS @alice\n",
    });
    expect(result.class).not.toBe("G1");
    expect(codes(result)).toContain("codeowners.path_uncovered");
  });

  it("fails on a CODEOWNERS syntax error even when the class was G3", async () => {
    const result = await check({
      codeowners: "/rules/\n",
      observation: { available: false, reason: "no token for INVARIANT_DOCTOR_TOKEN" },
      baseline: base({}, "G3"),
    });
    expect(result.class).toBe("G3");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "codeowners.syntax", severity: "fail" }),
    );
    expect(result.reasons).toContain("CODEOWNERS contains a line GitHub would silently skip.");
  });

  it("fails when a bypass actor appeared or grew since the baseline", async () => {
    const result = await check({
      observation: fullObservation({
        bypassActors: [{ type: "DeployKey", id: null, mode: "always" }],
      }),
    });
    expect(result.class).not.toBe("G1");
    expect(codes(result)).toContain("bypass.grew");
  });

  it("fails when merge queue is enabled but the workflow has no merge_group trigger", async () => {
    const result = await check({
      observation: fullObservation({ mergeQueue: "enabled" }),
      workflowText: WF_NO_MERGE,
    });
    expect(result.class).not.toBe("G1");
    expect(codes(result)).toContain("merge_queue.workflow_missing_trigger");
  });

  it("fails when another workflow defines a job named invariant-verdict", async () => {
    const result = await check({
      workflows: {
        ".github/workflows/other.yml": "jobs:\n  invariant-verdict:\n    runs-on: ubuntu-latest\n",
      },
      workflowFiles: ["invariant.yml", "other.yml"],
    });
    expect(result.class).not.toBe("G1");
    expect(codes(result)).toContain("check.name_ambiguous");
  });

  it("fails when the observed class regressed below the recorded baseline class", async () => {
    const result = await check({
      observation: fullObservation({ mechanism: "none", requiredContexts: [], codeOwnerReview: false }),
      baseline: base({}, "G1"),
    });
    expect(result.class).toBe("G3");
    expect(codes(result)).toContain("baseline.regressed");
  });

  it("is G3 — never G1 — for a repository with no protection at all", async () => {
    const result = await check({
      observation: fullObservation({ mechanism: "none", requiredContexts: [], codeOwnerReview: false }),
      baseline: base({}, "G3"),
    });
    expect(result.class).toBe("G3");
    expect(codes(result)).toContain("protection.none");
  });

  it("is G2 when a credential boundary is declared and only protection is missing (PEND-2)", async () => {
    const result = await check({
      observation: fullObservation({ mechanism: "none", requiredContexts: [], codeOwnerReview: false }),
      baseline: base({}, "G3"),
      config: { ...DEFAULT_CONFIG, credentialBoundary: "declared" },
    });
    expect(result.class).toBe("G2");
  });

  it("records merge_queue: unknown without downgrading (PEND-7)", async () => {
    const result = await check({ observation: fullObservation({ mergeQueue: "unknown" }) });
    expect(result.class).toBe("G1");
    expect(codes(result).some((code) => code.startsWith("merge_queue."))).toBe(false);
  });
});

describe("protection baseline", () => {
  it("defaults an absent file to G3 without blocking a fresh repository", async () => {
    const root = await makeTmpRepo({});
    const read = await readBaseline(root);
    expect(read.findings).toEqual([]);
    expect(read.baseline).toMatchObject({
      recorded_class: "G3",
      expected: {
        required_context: "invariant-verdict",
        required_context_app_id: DEFAULT_CONFIG.doctor.expectedAppId,
        protected_paths: DEFAULT_CONFIG.protectedPaths,
        bypass_actors: [],
      },
    });
  });

  it("round-trips a recorded baseline and renders deterministic JSON", async () => {
    const root = await makeTmpRepo({});
    const baseline = base({ bypass_actors: [{ type: "Team", id: 7, mode: "always" }] }, "G2");
    await writeBaseline(root, baseline);

    expect(await readBaseline(root)).toEqual({ baseline, findings: [] });
    expect(JSON.parse(renderBaseline(baseline))).toEqual(baseline);
    expect(renderBaseline(baseline).endsWith("\n")).toBe(true);
  });

  it("returns the default plus a baseline.unreadable finding for a malformed file", async () => {
    const root = await makeTmpRepo({ ".invariant/protection-baseline.json": "{not json" });
    const read = await readBaseline(root);
    expect(read.baseline.recorded_class).toBe("G3");
    expect(read.findings).toContainEqual(
      expect.objectContaining({ code: "baseline.unreadable", severity: "fail" }),
    );
  });
});
