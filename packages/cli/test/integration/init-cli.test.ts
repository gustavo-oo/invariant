import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTmpRepo } from "../helpers/fixture.js";
import { spawnCli } from "../helpers/run-cli.js";

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

describe("invariant init", () => {
  it("writes the walking skeleton and prints the class", async () => {
    const root = await makeTmpRepo({});
    const run = await spawnCli(
      [
        "init",
        root,
        "--owner",
        "@alice",
        "--cli-setup",
        "true",
        "--invariant-cmd",
        "node packages/cli/dist/cli.js",
      ],
      { cwd: root, env: env() },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("class: G3 (procedural)");
    const baseline = JSON.parse(
      await readFile(path.join(root, ".invariant/protection-baseline.json"), "utf8"),
    ) as { schema_version: number; recorded_class: string; expected: { required_context: string } };
    expect(baseline).toMatchObject({
      schema_version: 1,
      recorded_class: "G3",
      expected: { required_context: "invariant-verdict" },
    });
    expect(await readFile(path.join(root, "rules/example.yaml"), "utf8")).toContain("EXAMPLE-001");
    expect(await readFile(path.join(root, "invariant-example/limiter.ts"), "utf8")).toContain(
      "createLimiter",
    );
    expect(
      await readFile(path.join(root, ".github/workflows/invariant.yml"), "utf8"),
    ).toContain("invariant-verdict");
  });

  it("requires --owner", async () => {
    const root = await makeTmpRepo({});
    const run = await spawnCli(["init", root], { cwd: root, env: env() });

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("--owner");
  });
});
