import { describe, expect, it } from "vitest";
import { runFixture } from "../helpers/run-cli.js";

describe("Vue 3 + Fastify fixture (Part B)", () => {
  it("runs Vitest client/server and Playwright e2e in one gate", async () => {
    const run = await runFixture("vue-fastify", {
      args: [
        "verify",
        "--adapter",
        "vitest",
        "--adapter",
        "playwright",
        "--reports",
        "playwright=e2e/report.json",
      ],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.report?.checks.map((check) => check.check_id).sort()).toEqual([
      "checkout.completes",
      "checkout.ui-accepts-order",
      "orders.accepts-available",
    ]);
    expect(run.report?.flows[0]).toMatchObject({ flow_id: "checkout", verdict: "pass" });
    expect(run.report?.guarantee.negative_control).toBe("executed");
    expect(run.report?.rules.every((rule) => rule.sabotage_verified)).toBe(true);
  });
});
