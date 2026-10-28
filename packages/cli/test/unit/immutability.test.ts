import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readEvent, type CiContext } from "../../src/ci/event.js";
import { DEFAULT_CONFIG, type Config } from "../../src/config/model.js";
import { immutabilityFinding } from "../../src/immutability/diff.js";
import { createChangedFilesProvider } from "../../src/seams/changed-files.js";
import { commitAll, makeGitRepo, makeTmpRepo } from "../helpers/fixture.js";

/** Write `payload` as `event.json` in a fresh temp directory and return its path. */
const event = async (payload: unknown): Promise<string> => {
  const root = await makeTmpRepo({ "event.json": JSON.stringify(payload) });
  return path.join(root, "event.json");
};

/** A pull-request context with the given labels; `pr()` is an unflagged PR. */
const pr = (...labels: string[]): CiContext => ({
  mode: "pr",
  base: "b1",
  head: "h1",
  repo: null,
  runId: null,
  labels,
  eventStatus: "parsed",
});

/**
 * Run `fn` with `GITHUB_EVENT_PATH` set to `value` (or unset when `undefined`),
 * restoring the previous value even if the assertion throws. The suite runs in
 * GitHub Actions, where the variable is always set.
 */
async function withEventPath(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const saved = process.env["GITHUB_EVENT_PATH"];
  if (value === undefined) delete process.env["GITHUB_EVENT_PATH"];
  else process.env["GITHUB_EVENT_PATH"] = value;
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env["GITHUB_EVENT_PATH"];
    else process.env["GITHUB_EVENT_PATH"] = saved;
  }
}

describe("readEvent", () => {
  it("parses a pull_request event offline, including labels, base sha, repo and run id", async () => {
    const payload = {
      pull_request: {
        base: { sha: "b1" },
        head: { sha: "h1" },
        labels: [{ name: "invariant:rule-change" }, { name: 7 }, { id: 1 }],
      },
      repository: { full_name: "acme/shop" },
      run_id: 42,
    };
    const ctx = await readEvent(await event(payload));
    expect(ctx).toEqual({
      mode: "pr",
      base: "b1",
      head: "h1",
      repo: "acme/shop",
      runId: "42",
      labels: ["invariant:rule-change"],
      eventStatus: "parsed",
    });
  });

  it("reads a merge_group event from head_sha", async () => {
    const ctx = await readEvent(await event({ merge_group: { head_sha: "m1" } }));
    expect(ctx).toEqual({
      mode: "merge_group",
      base: null,
      head: "m1",
      repo: null,
      runId: null,
      labels: [],
      eventStatus: "parsed",
    });
  });

  it("parses a push event as a local audit, not an unreadable one", async () => {
    expect(await readEvent(await event({ push: {} }))).toEqual({
      mode: "local",
      base: null,
      head: null,
      repo: null,
      runId: null,
      labels: [],
      eventStatus: "parsed",
    });
  });

  it("reports an unreadable supplied path instead of pretending no event arrived", async () => {
    const unreadable: CiContext = {
      mode: "local",
      base: null,
      head: null,
      repo: null,
      runId: null,
      labels: [],
      eventStatus: "unreadable",
    };
    expect(await readEvent("/nope")).toEqual(unreadable);
    const root = await makeTmpRepo({ "event.json": "{not json" });
    expect(await readEvent(path.join(root, "event.json"))).toEqual(unreadable);
    // JSON that is not an object cannot describe an event either.
    expect(await readEvent(await event(["not", "an", "event"]))).toEqual(unreadable);
  });

  it("reports an absent event when no path was supplied at all (hermetic)", async () => {
    await withEventPath(undefined, async () => {
      expect(await readEvent(undefined)).toEqual({
        mode: "local",
        base: null,
        head: null,
        repo: null,
        runId: null,
        labels: [],
        eventStatus: "absent",
      });
    });
  });

  it("falls back to GITHUB_EVENT_PATH, parsing it as the event (hermetic)", async () => {
    const payload = {
      pull_request: { base: { sha: "b1" }, head: { sha: "h1" }, labels: [{ name: "invariant:rule-change" }] },
    };
    await withEventPath(await event(payload), async () => {
      const ctx = await readEvent(undefined);
      expect(ctx).toMatchObject({ mode: "pr", base: "b1", head: "h1", labels: ["invariant:rule-change"], eventStatus: "parsed" });
    });
  });
});

describe("immutabilityFinding", () => {
  it("fails when a protected path changed outside the flagged path (spec §12)", () => {
    const { finding } = immutabilityFinding({
      changed: ["rules/sales.yaml", "src/app.ts"],
      config: DEFAULT_CONFIG,
      context: pr(),
      protectedPaths: DEFAULT_CONFIG.protectedPaths,
    });
    expect(finding?.code).toBe("immutability.protected_path_changed");
    expect(finding?.file).toBe("rules/sales.yaml");
    expect(finding?.message).toContain("invariant:rule-change");
  });

  it("allows a flagged rule-change PR and records it", () => {
    const out = immutabilityFinding({
      changed: ["rules/sales.yaml"],
      config: DEFAULT_CONFIG,
      context: pr("invariant:rule-change"),
      protectedPaths: DEFAULT_CONFIG.protectedPaths,
    });
    expect(out).toEqual({ finding: null, protectedPathsChanged: ["rules/sales.yaml"], flagged: true });
  });

  it("records but does not fail protected changes on a push (post-merge audit)", () => {
    const out = immutabilityFinding({
      changed: [".invariant/sabotages/sales/stock.ts"],
      config: DEFAULT_CONFIG,
      context: { ...pr(), mode: "push" },
      protectedPaths: DEFAULT_CONFIG.protectedPaths,
    });
    expect(out).toEqual({ finding: null, protectedPathsChanged: [".invariant/sabotages/sales/stock.ts"], flagged: false });
  });

  it("records but does not fail protected changes on a merge queue or a local run", () => {
    for (const context of [{ ...pr(), mode: "merge_group" as const }, { ...pr(), mode: "local" as const }]) {
      const out = immutabilityFinding({
        changed: ["rules/sales.yaml"],
        config: DEFAULT_CONFIG,
        context,
        protectedPaths: DEFAULT_CONFIG.protectedPaths,
      });
      expect(out).toEqual({ finding: null, protectedPathsChanged: ["rules/sales.yaml"], flagged: false });
    }
  });

  it("keeps flagged label-based outside a PR", () => {
    const out = immutabilityFinding({
      changed: ["rules/sales.yaml"],
      config: DEFAULT_CONFIG,
      context: { ...pr("invariant:rule-change"), mode: "push" },
      protectedPaths: DEFAULT_CONFIG.protectedPaths,
    });
    expect(out).toEqual({ finding: null, protectedPathsChanged: ["rules/sales.yaml"], flagged: true });
  });

  it("yields no finding and records nothing for an unprotected change in a PR", () => {
    const out = immutabilityFinding({
      changed: ["src/app.ts", "README.md"],
      config: DEFAULT_CONFIG,
      context: pr(),
      protectedPaths: DEFAULT_CONFIG.protectedPaths,
    });
    expect(out).toEqual({ finding: null, protectedPathsChanged: [], flagged: false });
  });

  it("treats .invariant/, the workflow and CODEOWNERS as protected", () => {
    for (const file of [".invariant/sabotages/sales/stock.ts", ".github/workflows/invariant.yml", ".github/CODEOWNERS"]) {
      const out = immutabilityFinding({
        changed: [file],
        config: DEFAULT_CONFIG,
        context: pr(),
        protectedPaths: DEFAULT_CONFIG.protectedPaths,
      });
      expect(out.finding?.code).toBe("immutability.protected_path_changed");
      expect(out.finding?.file).toBe(file);
    }
  });

  it("matches a directory entry by prefix and a file entry exactly", () => {
    const out = immutabilityFinding({
      changed: ["rules", "rules.md", ".github/workflows/invariant.yml.bak", "src/rules/sales.yaml"],
      config: DEFAULT_CONFIG,
      context: pr(),
      protectedPaths: DEFAULT_CONFIG.protectedPaths,
    });
    expect(out).toEqual({ finding: null, protectedPathsChanged: [], flagged: false });
  });

  it("normalizes a leading ./ on both sides before matching", () => {
    const out = immutabilityFinding({
      changed: ["./rules/sales.yaml", "./src/app.ts"],
      config: DEFAULT_CONFIG,
      context: pr(),
      protectedPaths: ["./rules/"],
    });
    expect(out.protectedPathsChanged).toEqual(["rules/sales.yaml"]);
    expect(out.finding?.file).toBe("rules/sales.yaml");
  });

  it("records the protected subset sorted and de-duplicated", () => {
    const out = immutabilityFinding({
      changed: ["rules/b.yaml", ".github/CODEOWNERS", "rules/a.yaml", "rules/b.yaml", ".invariant/x.ts"],
      config: DEFAULT_CONFIG,
      context: pr(),
      protectedPaths: DEFAULT_CONFIG.protectedPaths,
    });
    expect(out.protectedPathsChanged).toEqual([".github/CODEOWNERS", ".invariant/x.ts", "rules/a.yaml", "rules/b.yaml"]);
  });

  it("keeps the human finding on one line when a filename contains a newline", () => {
    const out = immutabilityFinding({
      changed: ["rules/evil\nname.yaml"],
      config: DEFAULT_CONFIG,
      context: pr(),
      protectedPaths: DEFAULT_CONFIG.protectedPaths,
    });
    expect(out.finding?.file).toBe("rules/evil\nname.yaml");
    expect(out.finding?.message).toBe(
      'protected path changed without the "invariant:rule-change" label: rules/evil name.yaml',
    );
  });

  it("uses the supplied protectedPaths and the configured label", () => {
    const config: Config = { ...DEFAULT_CONFIG, ruleChange: { label: "acme:rule-edit" } };
    const out = immutabilityFinding({
      changed: ["policy/a.yaml", "rules/sales.yaml"],
      config,
      context: pr("acme:rule-edit"),
      protectedPaths: ["policy/"],
    });
    expect(out.finding).toBeNull();
    expect(out.flagged).toBe(true);
    expect(out.protectedPathsChanged).toEqual(["policy/a.yaml"]);

    const unflagged = immutabilityFinding({
      changed: ["policy/a.yaml"],
      config,
      context: pr("invariant:rule-change"),
      protectedPaths: ["policy/"],
    });
    expect(unflagged.finding?.code).toBe("immutability.protected_path_changed");
    expect(unflagged.finding?.message).toContain("acme:rule-edit");
    expect(unflagged.flagged).toBe(false);
  });
});

describe("changedFiles", () => {
  const provider = createChangedFilesProvider();

  it("returns the sorted, repo-relative files changed between base and head", async () => {
    const { root, baseSha } = await makeGitRepo({ "src/a.ts": "a\n", "src/b.ts": "b\n", "README.md": "readme\n" });
    await writeFile(path.join(root, "src/b.ts"), "b2\n", "utf8");
    await mkdir(path.join(root, "rules"), { recursive: true });
    await writeFile(path.join(root, "rules/sales.yaml"), "rules\n", "utf8");
    await commitAll(root, "feature");

    const diff = await provider.changedFiles(root, baseSha, "HEAD");
    expect(diff).toEqual({ files: ["rules/sales.yaml", "src/b.ts"], base: baseSha, head: "HEAD" });
  });

  it("returns no files when nothing changed", async () => {
    const { root, baseSha } = await makeGitRepo({ "README.md": "readme\n" });
    expect((await provider.changedFiles(root, baseSha, "HEAD")).files).toEqual([]);
  });

  it("reports both the diff and the shallow-fetch failure when the base stays unknown", async () => {
    const { root } = await makeGitRepo({ "README.md": "readme\n" });
    const error = await provider.changedFiles(root, "does-not-exist", "HEAD").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("git diff --name-only --no-renames -z does-not-exist...HEAD failed");
    expect(message).toContain("git fetch --depth=1 origin does-not-exist failed");
  });

  it("throws when git cannot run in the directory at all", async () => {
    const root = await makeTmpRepo({ "README.md": "readme\n" });
    await expect(provider.changedFiles(root, "HEAD", "HEAD")).rejects.toThrow(/Not a git repository/);
  });
});
