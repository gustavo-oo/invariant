import { describe, expect, it } from "vitest";
import type { DiscoveredCheck } from "../../src/discovery/types.js";
import { makeVitestRepo } from "../helpers/fixture.js";
import { capability } from "../helpers/registry.js";
import { spawnCli } from "../helpers/run-cli.js";
import { stubAdapter } from "../helpers/stub-adapter.js";

describe("makeVitestRepo", () => {
  it("runs a real project's vitest through a symlinked node_modules, offline", async () => {
    const root = await makeVitestRepo({
      "package.json": JSON.stringify({ name: "fx", type: "module", private: true }),
      "rules/sales.yaml": capability("SALES-004"),
      "src/a.test.ts": `import { expect, test } from "vitest";\n\n// @check sales.rejects-insufficient-stock\n// @rule SALES-004\ntest("ok", () => { expect(1).toBe(1); });\n`,
    });

    const { exitCode, stdout, stderr } = await spawnCli(["run"], { cwd: root });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("sales.rejects-insufficient-stock");
    expect(stderr).toBe("");
  });

  it("is idempotent when the same package is symlinked twice", async () => {
    const files = { "package.json": "{}" };
    const root = await makeVitestRepo(files);
    expect(await makeVitestRepo(files, { into: root })).toBe(root);
  });
});

describe("stubAdapter", () => {
  const check: DiscoveredCheck = {
    checkId: "sales.a",
    rules: ["SALES-004"],
    flows: [],
    testName: "works",
    file: "src/a.test.ts",
    line: 3,
    frameworkId: "stub",
    runtimeId: "sales > works",
  };

  it("returns the discovered checks and aligns results by runtimeId", async () => {
    const adapter = stubAdapter({
      discovered: [check],
      results: [{ runtimeId: "sales > works", outcome: "fail" }],
    });

    expect(await adapter.discover(".")).toEqual({ checks: [check], errors: [] });
    expect(await adapter.run([check], { root: "." })).toEqual([
      { runtimeId: "sales > works", outcome: "fail", frameworkId: "stub" },
    ]);
    expect(await adapter.readReports([], ".")).toEqual([
      { runtimeId: "sales > works", outcome: "fail" },
    ]);
  });

  it("fills a missing result with not-run instead of greening it", async () => {
    const adapter = stubAdapter({ discovered: [check], results: [] });
    expect(await adapter.run([check], { root: "." })).toEqual([
      { runtimeId: "sales > works", outcome: "not-run", frameworkId: "stub" },
    ]);
  });
});
