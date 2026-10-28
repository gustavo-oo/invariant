import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectGolden } from "../helpers/goldens.js";
import { runFixture } from "../helpers/run-cli.js";

const EXECUTED = "negative control: executed — ";
const NOT_EXECUTED = "negative control: not executed — ";
const CHECK_ID = "sales.rejects-insufficient-stock";

interface Artifact {
  declared: number;
  executed: boolean;
  outcomes: Record<string, unknown>;
  findings: Array<{ code: string }>;
}

describe("invariant negative", () => {
  it("executes the declared sabotage and proves the check", async () => {
    const run = await runFixture("healthy-registry", { args: ["negative"] });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe(`${EXECUTED}1/1 checks proven able to fail\ndeclared: 1 checks\n`);
    expect(run.stderr).toBe("");
  });

  it("exits 2 when the sabotage lacks a @seam-alias", async () => {
    const run = await runFixture("sabotage-missing-alias", { args: ["negative"] });

    expect(run.exitCode).toBe(2);
    await expectGolden("sabotage-missing-alias", run.stdout, "stdout.txt");
    await expectGolden("sabotage-missing-alias", run.stderr, "stderr.txt");
  });

  it("writes the executed artifact under --json --out", async () => {
    const run = await runFixture("healthy-registry", {
      args: ["negative", "--json", "--out", "negative-result.json"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
    const artifact = JSON.parse(
      await readFile(path.join(run.root, "negative-result.json"), "utf8"),
    ) as Artifact;
    expect(artifact).toEqual({
      declared: 1,
      executed: true,
      outcomes: { [CHECK_ID]: { status: "applied", classification: "assertion" } },
      findings: [],
    });
  });

  it("marks a no-op sabotage as a product red", async () => {
    const run = await runFixture("no-op-sabotage", { args: ["negative", "--json"] });

    expect(run.exitCode).toBe(1);
    const artifact = JSON.parse(run.stdout) as Artifact;
    expect(artifact.executed).toBe(true);
    expect(artifact.outcomes[CHECK_ID]).toEqual({ status: "not-applied" });
    expect(artifact.findings.map((finding) => finding.code)).toContain("negative.sabotage_not_applied");
  });

  it("marks a broken sabotage as harness, never proof", async () => {
    const run = await runFixture("sabotage-does-not-compile", { args: ["negative", "--json"] });

    expect(run.exitCode).toBe(1);
    const artifact = JSON.parse(run.stdout) as Artifact;
    expect(artifact.outcomes[CHECK_ID]).toEqual({ status: "applied", classification: "harness" });
  });

  it("fails closed on an invalid registry before checking declarations", async () => {
    const run = await runFixture("invalid-registry", { args: ["negative"] });

    expect(run.exitCode).toBe(2);
    expect(run.stdout.startsWith(`${NOT_EXECUTED}the registry is invalid`)).toBe(true);
    expect(run.stderr).toContain("registry.");
  });
});
