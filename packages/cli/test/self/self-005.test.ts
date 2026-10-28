import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { defaultBaseline } from "../../src/doctor/baseline.js";
import { runDoctorChecks } from "../../src/doctor/checks.js";
import { computeClass } from "../../src/guarantee/class.js";
import { createForgeProbe } from "../../src/seams/forge-probe.js";
import { makeTmpRepo } from "../helpers/fixture.js";

describe("SELF-005", () => {
  // @check self.guarantee-class
  // @rule SELF-005
  // @flow self-verify/s3
  it("never claims a guarantee class the environment does not support", async () => {
    const root = await makeTmpRepo({});
    const { config } = await loadConfig(root);
    const tokenEnv = "INVARIANT_TEST_SELF005_TOKEN";
    const previous = process.env[tokenEnv];
    delete process.env[tokenEnv];
    try {
      const scoped = { ...config, doctor: { ...config.doctor, tokenEnv } };
      const observation = await createForgeProbe(scoped).observe(root);
      const checked = runDoctorChecks({
        observation,
        config: scoped,
        baseline: defaultBaseline(scoped),
        root,
        workflowText: "",
        workflowFiles: [],
      });

      expect(observation.available).toBe(false);
      expect(checked.class).not.toBe("G1");
      expect(checked.class).toBe("G3");
    } finally {
      if (previous !== undefined) process.env[tokenEnv] = previous;
    }
  });

  it("does reach G1 for a complete observation with no findings", () => {
    expect(
      computeClass({
        observationAvailable: true,
        protectionFindings: [],
        credentialBoundary: false,
      }).class,
    ).toBe("G1");
  });
});
