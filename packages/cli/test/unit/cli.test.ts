import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { EXIT } from "../../src/exit.js";

describe("cli", () => {
  it("prints the version and exits 0", async () => {
    const out: string[] = [];
    const code = await runCli(["--version"], { cwd: process.cwd(), stdout: (s) => out.push(s), stderr: () => {} });
    expect(code).toBe(EXIT.GREEN);
    expect(out.join("")).toMatch(/^invariant \d+\.\d+\.\d+\n$/);
  });

  it("prints usage and exits 2 for an unknown subcommand", async () => {
    const err: string[] = [];
    const code = await runCli(["status"], { cwd: process.cwd(), stdout: () => {}, stderr: (s) => err.push(s) });
    expect(code).toBe(EXIT.GATE_BROKEN);
    expect(err.join("")).toContain("unknown subcommand: status");
  });

  it("prints the full command table on --help and exits 0", async () => {
    const out: string[] = [];
    const code = await runCli(["--help"], { cwd: process.cwd(), stdout: (s) => out.push(s), stderr: () => {} });
    expect(code).toBe(EXIT.GREEN);
    for (const name of ["validate", "run", "negative", "verdict", "verify", "doctor", "init"]) {
      expect(out.join("")).toContain(`invariant ${name}`);
    }
  });

  it("treats a missing subcommand as unknown and exits 2", async () => {
    const err: string[] = [];
    const code = await runCli([], { cwd: process.cwd(), stdout: () => {}, stderr: (s) => err.push(s) });
    expect(code).toBe(EXIT.GATE_BROKEN);
    expect(err.join("")).toContain("unknown subcommand:");
  });
});
