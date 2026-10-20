import { describe, expect, it } from "vitest";
import { expectGolden } from "../helpers/goldens.js";
import { runFixture } from "../helpers/run-cli.js";

describe("invariant validate", () => {
  it("exits 2 and emits no verdicts for an invalid registry", async () => {
    const run = await runFixture("invalid-registry");
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    await expectGolden("invalid-registry", run.stderr, "stderr.txt");
  });

  it("exits 0 for a registry with no enforced rules and says so", async () => {
    const run = await runFixture("empty-registry");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("0 enforced rules");
    await expectGolden("empty-registry", run.stdout, "stdout.txt");
  });

  it("exits 2, not 1, when an I/O failure prevents the verifier from running", async () => {
    // `missing-dir` does not exist, so writeFileSync fails deterministically —
    // no permissions trick. An infrastructure failure is "the verifier could
    // not run" (exit 2), never a false "rule not green" (exit 1).
    const run = await runFixture("empty-registry", { args: ["validate", "--out", "missing-dir/out.txt"] });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("invariant:");
    expect(run.stderr).toContain("missing-dir");
    expect(run.stderr).not.toMatch(/\n\s+at /);
  });
});
