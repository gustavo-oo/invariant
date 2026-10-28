import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/model.js";
import { renderWorkflow } from "../../src/workflow/render.js";

const TEMPLATE = fileURLToPath(new URL("../../src/assets/workflow.yml", import.meta.url));
const COMMITTED = fileURLToPath(
  new URL("../../../../.github/workflows/invariant.yml", import.meta.url),
);
const PACKAGE = fileURLToPath(new URL("../../package.json", import.meta.url));

describe("shipped workflow", () => {
  it("is exactly the template rendered with the dogfood parameters", async () => {
    const pkg = JSON.parse(await readFile(PACKAGE, "utf8")) as { version: string };
    const params = {
      cliSetup: "npm ci --ignore-scripts && npm run build",
      invariantCmd: "node packages/cli/dist/cli.js",
      invariantVersion: pkg.version,
      protectedPaths: DEFAULT_CONFIG.protectedPaths,
    };

    expect(await readFile(COMMITTED, "utf8")).toBe(
      renderWorkflow(await readFile(TEMPLATE, "utf8"), params),
    );
  });
});
