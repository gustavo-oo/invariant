import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { TOOL_VERSION } from "../../src/version.js";

describe("TOOL_VERSION", () => {
  it("stays in sync with packages/cli/package.json", async () => {
    const pkg = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: string };

    expect(TOOL_VERSION).toBe(pkg.version);
  });
});
