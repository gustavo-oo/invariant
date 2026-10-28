import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/model.js";
import { renderWorkflow } from "../../src/workflow/render.js";

const TEMPLATE = fileURLToPath(new URL("../../src/assets/workflow.yml", import.meta.url));
const PACKAGE = fileURLToPath(new URL("../../package.json", import.meta.url));

async function defaults(): Promise<{
  cliSetup: string;
  invariantCmd: string;
  invariantVersion: string;
  protectedPaths: string[];
}> {
  const pkg = JSON.parse(await readFile(PACKAGE, "utf8")) as { version: string };
  return {
    cliSetup: `npm install --no-save --no-fund invariant@${pkg.version}`,
    invariantCmd: "npx --no-install invariant",
    invariantVersion: pkg.version,
    protectedPaths: DEFAULT_CONFIG.protectedPaths,
  };
}

interface Workflow {
  on: Record<string, unknown>;
  jobs: Record<
    string,
    {
      uses?: string;
      if?: string;
      needs?: string[];
      permissions?: Record<string, string>;
      steps?: Array<{
        id?: string;
        uses?: string;
        run?: string;
        env?: Record<string, string>;
        with?: Record<string, unknown>;
      }>;
    }
  >;
}

describe("renderWorkflow", () => {
  it("renders a valid workflow whose required check is exactly invariant-verdict", async () => {
    const text = renderWorkflow(await readFile(TEMPLATE, "utf8"), await defaults());
    const yml = parse(text) as Workflow;

    expect(Object.keys(yml.jobs)).toEqual([
      "invariant-registry",
      "invariant-checks",
      "invariant-negative",
      "invariant-verdict",
    ]);
    expect(yml.jobs["invariant-verdict"]?.uses).toBeUndefined();
    expect(yml.jobs["invariant-verdict"]?.if).toBe("always()");
    expect(yml.jobs["invariant-verdict"]?.needs).toEqual([
      "invariant-registry",
      "invariant-checks",
      "invariant-negative",
    ]);
    expect(Object.keys(yml.on).sort()).toEqual(["merge_group", "pull_request", "workflow_call"]);
    for (const job of Object.values(yml.jobs)) {
      expect(job.permissions?.["contents"]).toBe("read");
    }
  });

  it("pins the CI contract: full history, the event, and the three artifacts", async () => {
    const text = renderWorkflow(await readFile(TEMPLATE, "utf8"), await defaults());
    const yml = parse(text) as Workflow;

    for (const name of ["invariant-registry", "invariant-checks", "invariant-negative"]) {
      const job = yml.jobs[name];
      expect(job?.steps?.[0]).toMatchObject({ uses: "actions/checkout@v4", with: { "fetch-depth": 0 } });
      expect(job?.steps?.some((step) => step.uses === "actions/upload-artifact@v4")).toBe(true);
    }

    const registry = yml.jobs["invariant-registry"]?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    expect(registry).toContain('--event "$GITHUB_EVENT_PATH"');
    expect(registry).toContain("invariant-inputs/invariant-registry/registry-result.json");

    const checks = yml.jobs["invariant-checks"]?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    expect(checks).toContain("inputs.reports");
    expect(checks).toContain("invariant-inputs/invariant-checks/checks-result.json");

    const negative = yml.jobs["invariant-negative"]?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    expect(negative).toContain("invariant-inputs/invariant-negative/negative-result.json");

    const verdict = yml.jobs["invariant-verdict"]?.steps ?? [];
    const appToken = verdict.find((step) => step.uses === "actions/create-github-app-token@v1");
    expect(appToken?.id).toBe("invariant-app-token");
    expect(appToken?.with).toMatchObject({
      "app-id": "${{ env.INVARIANT_APP_ID }}",
      "private-key": "${{ env.INVARIANT_APP_PRIVATE_KEY }}",
      repositories: "${{ github.event.repository.name }}",
    });
    const doctor = verdict.find((step) => step.run?.includes("doctor"));
    expect(doctor?.env?.INVARIANT_DOCTOR_TOKEN).toBe(
      "${{ steps.invariant-app-token.outputs.token }}",
    );
    expect(text).not.toContain("secrets.INVARIANT_DOCTOR_TOKEN");
    const download = verdict.find((step) => step.uses === "actions/download-artifact@v4");
    expect(download?.with).toMatchObject({
      path: "./invariant-inputs",
      pattern: "invariant-*",
      "merge-multiple": true,
    });
    expect(verdict.some((step) => step.run?.includes("doctor"))).toBe(true);
    expect(verdict.some((step) => step.run?.includes("--job-status invariant-checks="))).toBe(true);
    expect(verdict.some((step) => step.run?.includes("gh pr comment"))).toBe(true);
  });

  it("rejects a template with an unknown placeholder", async () => {
    const text = renderWorkflow(await readFile(TEMPLATE, "utf8"), await defaults());
    const params = await defaults();
    expect(() => renderWorkflow(`${text}\n# __UNKNOWN__\n`, params)).toThrow(/__UNKNOWN__/);
  });
});
