import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapter, CheckResult } from "../../src/adapter/api.js";
import { alignReportResults } from "../../src/adapter/align.js";
import { executeAdapters } from "../../src/adapter/execute.js";
import { loadConfig } from "../../src/config/load.js";
import type { DiscoveredCheck } from "../../src/discovery/types.js";

function check(checkId: string, frameworkId: string, runtimeId = "same"): DiscoveredCheck {
  return {
    checkId,
    rules: [],
    flows: [],
    testName: runtimeId,
    file: `${frameworkId}/${runtimeId}.test.ts`,
    line: 1,
    frameworkId,
    runtimeId,
  };
}

function stub(id: string, outcome: CheckResult["outcome"] = "pass"): Adapter {
  return {
    id,
    async discover() {
      return { checks: [], errors: [] };
    },
    async run(checks) {
      return checks.map((item) => ({ runtimeId: item.runtimeId, outcome }));
    },
    async readReports() {
      return null;
    },
    async applySabotage() {
      return { status: "not-applied" };
    },
    classifyFailure() {
      return "harness";
    },
  };
}

async function configRepo(text: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "invariant-config-"));
  await mkdir(path.join(root, ".invariant"), { recursive: true });
  await writeFile(path.join(root, ".invariant/config.yaml"), text, "utf8");
  return root;
}

describe("multi-adapter execution", () => {
  it("runs each framework once and preserves the caller's order", async () => {
    const a = stub("a");
    const b = stub("b");
    const checks = [check("a.same", "a"), check("b.same", "b")];

    const results = await executeAdapters([a, b], checks, { root: "." }, []);

    expect(results).toEqual([
      { runtimeId: "same", outcome: "pass", frameworkId: "a" },
      { runtimeId: "same", outcome: "pass", frameworkId: "b" },
    ]);
  });

  it("does not let an equal runtimeId from one framework satisfy another", () => {
    const checks = [check("a.same", "a"), check("b.same", "b")];
    const results = alignReportResults(checks, [
      { runtimeId: "same", outcome: "pass", frameworkId: "a" },
    ]);

    expect(results).toEqual([
      { runtimeId: "same", outcome: "pass", frameworkId: "a" },
      { runtimeId: "same", outcome: "not-run", frameworkId: "b" },
    ]);
  });
});

describe("adapters config", () => {
  it("reads adapters[] and keeps adapter as the first alias", async () => {
    const root = await configRepo("adapters: [vitest, playwright]\n");
    const { config, findings } = await loadConfig(root);
    expect(config.adapters).toEqual(["vitest", "playwright"]);
    expect(config.adapter).toBe("vitest");
    expect(findings).toEqual([]);
  });

  it("falls back to the legacy adapter key", async () => {
    const root = await configRepo("adapter: vitest\n");
    const { config } = await loadConfig(root);
    expect(config.adapters).toEqual(["vitest"]);
  });

  it("reports a conflict when both adapter and adapters are set", async () => {
    const root = await configRepo("adapter: vitest\nadapters: [vitest]\n");
    const { findings } = await loadConfig(root);
    expect(findings.map((finding) => finding.code)).toContain("config.adapter_conflict");
  });
});
