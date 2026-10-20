import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/model.js";
import { createDiscoverySource } from "../../src/seams/discovery-source.js";
import { makeTmpRepo } from "../helpers/fixture.js";

describe("createDiscoverySource", () => {
  it("discovers through the configured adapter, and an empty repo has nothing to report", async () => {
    const root = await makeTmpRepo({});
    const source = createDiscoverySource(DEFAULT_CONFIG);
    expect(source.id).toBe("vitest");
    await expect(source.discover(root)).resolves.toEqual({ checks: [], errors: [] });
  });

  it("reports an unknown adapter as an error instead of throwing", async () => {
    const root = await makeTmpRepo({});
    const source = createDiscoverySource({ ...DEFAULT_CONFIG, adapter: "jest" });
    const result = await source.discover(root);
    expect(result.checks).toEqual([]);
    expect(result.errors[0]?.message).toContain("unknown adapter: jest");
  });
});
