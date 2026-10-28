import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectGolden } from "../helpers/goldens.js";
import { runFixture } from "../helpers/run-cli.js";

const NOTICE =
  "negative control: declared-only — seam sabotage is NOT executed in this delivery (Phase 2)";

describe("invariant negative", () => {
  it("reports a complete declaration and the not-executed notice", async () => {
    const run = await runFixture("healthy-registry", { args: ["negative"] });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe(`${NOTICE}\ndeclared: 1 checks\n`);
    expect(run.stderr).toBe("");
  });

  it("exits 2 when the sabotage lacks a @seam-alias, with the notice still first", async () => {
    const run = await runFixture("sabotage-missing-alias", { args: ["negative"] });

    expect(run.exitCode).toBe(2);
    await expectGolden("sabotage-missing-alias", run.stdout, "stdout.txt");
    await expectGolden("sabotage-missing-alias", run.stderr, "stderr.txt");
  });

  it("writes {declared, executed, findings} under --json --out", async () => {
    const run = await runFixture("healthy-registry", {
      args: ["negative", "--json", "--out", "negative-result.json"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
    const artifact = JSON.parse(
      await readFile(path.join(run.root, "negative-result.json"), "utf8"),
    ) as unknown;
    expect(artifact).toEqual({ declared: 1, executed: false, findings: [] });
  });

  it("fails closed on an invalid registry before checking declarations", async () => {
    const run = await runFixture("invalid-registry", { args: ["negative"] });

    expect(run.exitCode).toBe(2);
    expect(run.stdout.startsWith(NOTICE)).toBe(true);
    expect(run.stderr).toContain("registry.");
  });
});
