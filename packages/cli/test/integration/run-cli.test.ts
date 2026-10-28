import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectGolden } from "../helpers/goldens.js";
import { runFixture } from "../helpers/run-cli.js";

describe("invariant run", () => {
  it("exits 1 when an enforced rule's check never runs", async () => {
    const run = await runFixture("not-run-check", { args: ["run"] });
    // A skipped check is not an infrastructure failure: the product (the rule)
    // is broken, so this is exit 1 and stderr stays silent.
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("not-run");
    expect(run.stderr).toBe("");
    await expectGolden("not-run-check", run.stdout, "stdout.txt");
  });

  it("validates the registry first and emits no check lines when it is invalid", async () => {
    const run = await runFixture("invalid-registry", { args: ["run"] });
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    // Exactly the findings `validate` prints, so one source of truth formats both.
    await expectGolden("invalid-registry", run.stderr, "stderr.txt");
  });

  it("exits 0 and says so when the registry declares no enforced rules", async () => {
    const run = await runFixture("empty-registry", { args: ["run"] });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("0 enforced rules\n");
    expect(run.stderr).toBe("");
  });

  it("exits 2 and executes nothing when discovery fails", async () => {
    const run = await runFixture("not-run-check", { args: ["run", "--adapter", "unknown"] });
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("unknown adapter: unknown");
  });

  it("emits {checks} under --json instead of check lines", async () => {
    const run = await runFixture("not-run-check", { args: ["run", "--json"] });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual({
      checks: [{ runtimeId: "never runs", outcome: "not-run" }],
    });
  });

  it("prefers a report over executing and maps it onto checks by runtimeId", async () => {
    // The actual test is skipped, so a run would be not-run (exit 1). The report
    // says pass; exit 0 proves the report was read first and Vitest was not run.
    const run = await runFixture("not-run-check", {
      args: ["run", "--reports", "reports/vitest.json"],
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("sales.never-runs never runs pass\n");
    expect(run.stderr).toBe("");
  });

  it("consumes each report result once when two checks share a runtimeId (R35)", async () => {
    const run = await runFixture("duplicate-runtime-id", {
      args: ["run", "--reports", "reports/vitest.json"],
    });

    expect(run.exitCode).toBe(1);
    const lines = run.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.filter((line) => line.endsWith(" pass"))).toHaveLength(1);
    expect(lines.filter((line) => line.endsWith(" fail"))).toHaveLength(1);
    expect(run.stderr).toBe("");
  });

  it("writes the JSON artifact on --out, even without --json", async () => {
    const run = await runFixture("not-run-check", { args: ["run", "--out", "run-out.json"] });
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
    const artifact = JSON.parse(await readFile(path.join(run.root, "run-out.json"), "utf8")) as unknown;
    expect(artifact).toEqual({ checks: [{ runtimeId: "never runs", outcome: "not-run" }] });
  });
});
