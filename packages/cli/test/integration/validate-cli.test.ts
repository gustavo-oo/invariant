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
});
