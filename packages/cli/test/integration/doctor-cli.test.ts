import { describe, expect, it } from "vitest";
import { runFixture } from "../helpers/run-cli.js";

function env(): NodeJS.ProcessEnv {
  const copy = { ...process.env };
  for (const name of [
    "INVARIANT_DOCTOR_TOKEN",
    "GITHUB_REPOSITORY",
    "GITHUB_RUN_ID",
    "GITHUB_EVENT_PATH",
  ]) {
    delete copy[name];
  }
  return copy;
}

describe("invariant doctor", () => {
  it("prints the class actually in force when no token is available, and never claims G1", async () => {
    const run = await runFixture("no-protection", { args: ["doctor", "--json"], env: env() });

    expect(run.exitCode).toBe(0);
    expect(run.doctor?.class).toBe("G3");
    expect(run.doctor?.observation).toMatchObject({ available: false });
    expect(run.stdout).toContain("G3 (procedural)");
    // The human block is still the primary output; --json writes the artifact.
    expect(run.stdout).toContain("observation: unavailable");
    expect(run.stdout).toContain("what this class means:");
  });

  it("exits 1 under --strict for a repository with no protection", async () => {
    const run = await runFixture("no-protection", { args: ["doctor", "--strict"], env: env() });
    expect(run.exitCode).toBe(1);
  });

  it("--record writes the observed class and attributes into the baseline", async () => {
    const run = await runFixture("no-protection", { args: ["doctor", "--record"], env: env() });

    expect(run.exitCode).toBe(0);
    expect(run.baseline?.recorded_class).toBe("G3");
    expect(run.baseline?.expected.required_context).toBe("invariant-verdict");
    expect(run.baseline?.expected.protected_paths).toEqual([
      "rules/",
      ".invariant/",
      ".github/workflows/invariant.yml",
      ".github/CODEOWNERS",
    ]);
  });

  it("writes the DoctorResult envelope with the explicit repo and run id", async () => {
    const run = await runFixture("no-protection", {
      args: ["doctor", "--json", "--repo", "acme/shop", "--run-id", "42"],
      env: env(),
    });

    expect(run.doctor?.repo).toBe("acme/shop");
    expect(run.doctor?.run_id).toBe("42");
    expect(run.doctor?.schema_version).toBe(1);
  });
});
