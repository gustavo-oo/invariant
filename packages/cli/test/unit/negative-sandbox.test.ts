import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createSandbox,
  isSymlink,
  NO_NETWORK_PRELOAD,
  sanitizedEnv,
} from "../../src/negative/sandbox.js";
import { makeTmpRepo } from "../helpers/fixture.js";

const execFileAsync = promisify(execFile);

describe("createSandbox", () => {
  it("copies the tree, excludes secrets and .git, and recreates node_modules", async () => {
    const source = await makeTmpRepo({
      "package.json": "{}",
      "src/a.ts": "export const a = 1",
      ".env": "TOKEN=secret",
      ".env.local": "TOKEN=also-secret",
      ".git/objects/x": "",
      "node_modules/.bin/x": "",
    });

    const sandbox = await createSandbox(source, "test");
    try {
      expect(await readFile(path.join(sandbox.root, "src/a.ts"), "utf8")).toBe("export const a = 1");
      await expect(stat(path.join(sandbox.root, ".env"))).rejects.toThrow();
      await expect(stat(path.join(sandbox.root, ".env.local"))).rejects.toThrow();
      await expect(stat(path.join(sandbox.root, ".git"))).rejects.toThrow();
      expect((await stat(path.join(sandbox.root, "node_modules"))).isDirectory()).toBe(true);
      expect(await isSymlink(path.join(sandbox.root, "node_modules/.bin"))).toBe(true);
      await expect(stat(path.join(sandbox.root, ".invariant-no-network.mjs"))).resolves.toBeTruthy();
    } finally {
      await sandbox.cleanup();
    }
    await expect(stat(sandbox.root)).rejects.toThrow();
  });

  it("keeps a subdirectory node_modules as a farm too", async () => {
    const source = await makeTmpRepo({
      "client/package.json": "{}",
      "client/node_modules/pkg/index.js": "module.exports = 1",
    });
    const sandbox = await createSandbox(source, "nested");
    try {
      expect((await stat(path.join(sandbox.root, "client/node_modules"))).isDirectory()).toBe(true);
      expect(await isSymlink(path.join(sandbox.root, "client/node_modules/pkg"))).toBe(true);
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe("sanitizedEnv", () => {
  it("drops credentials, points HOME at the sandbox and loads the preload", () => {
    const env = sanitizedEnv(
      {
        PATH: "/bin",
        HOME: "/home/u",
        GITHUB_TOKEN: "x",
        INVARIANT_DOCTOR_TOKEN: "y",
        AWS_SECRET_ACCESS_KEY: "z",
        PLAYWRIGHT_BROWSERS_PATH: "/browsers",
      },
      "/tmp/sandbox",
    );

    expect(env["GITHUB_TOKEN"]).toBeUndefined();
    expect(env["INVARIANT_DOCTOR_TOKEN"]).toBeUndefined();
    expect(env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
    expect(env["HOME"]).toBe("/tmp/sandbox");
    expect(env["PATH"]).toBe("/bin");
    expect(env["TMPDIR"]).toBe("/tmp/sandbox/.invariant-tmp");
    expect(env["CI"]).toBe("1");
    expect(env["PLAYWRIGHT_BROWSERS_PATH"]).toBe("/browsers");
    expect(env["NODE_OPTIONS"]).toContain("--import");
  });
});

describe("no-network preload", () => {
  const preload = pathToFileURL(NO_NETWORK_PRELOAD).href;

  it("blocks a non-loopback fetch", async () => {
    const script = 'try { fetch("https://example.com"); } catch (error) { console.error(error.message); process.exit(1); }';
    await expect(
      execFileAsync(process.execPath, ["--import", preload, "--input-type=module", "-e", script], {
        encoding: "utf8",
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("network is disabled"),
    });
  });

  it("allows a loopback connection", async () => {
    const script = [
      'import http from "node:http";',
      'const request = http.get("http://127.0.0.1:1", () => {});',
      'request.on("error", (error) => { console.log(error.code); });',
    ].join("\n");
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", preload, "--input-type=module", "-e", script],
      { encoding: "utf8" },
    );
    expect(stdout.trim()).toBe("ECONNREFUSED");
  });

  it("blocks the port/host form as well as a URL", async () => {
    const script = [
      'import net from "node:net";',
      'try { net.connect(80, "example.com"); } catch (error) { console.error(error.message); process.exit(1); }',
    ].join("\n");
    await expect(
      execFileAsync(process.execPath, ["--import", preload, "--input-type=module", "-e", script], {
        encoding: "utf8",
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("network is disabled"),
    });
  });
});
