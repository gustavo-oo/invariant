import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { linkNodeModules } from "./node-modules.js";

const execFileAsync = promisify(execFile);

/**
 * Write `files` (repo-relative path -> content) into a fresh temporary
 * directory and return the **realpath** of its root, so macOS's
 * `/private/var/...` prefix never leaks into an assertion.
 */
export async function makeTmpRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "invariant-repo-"));
  await writeFiles(root, files);
  return await realpath(root);
}

/**
 * A temporary repo whose tests can actually run under Vitest offline: the
 * `makeTmpRepo` semantics plus a `node_modules` link to the workspace install,
 * so no copy and no install step. `into` writes into an existing root (the
 * idempotency case); without it a fresh temp directory is created.
 */
export async function makeVitestRepo(
  files: Record<string, string>,
  opts: { into?: string } = {},
): Promise<string> {
  const root = opts.into ?? (await mkdtemp(path.join(tmpdir(), "invariant-repo-")));
  await writeFiles(root, files);
  await linkNodeModules(root);
  return await realpath(root);
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

/**
 * Write `files` into a fresh git repository and commit them, so a test can
 * produce a real base commit and then change files on top of it (immutability
 * needs a diff with history, not just a directory). Returns the repo root and
 * the base commit's sha.
 *
 * Identity and signing are pinned on the command line: the test must not depend
 * on the developer's `~/.gitconfig` (or fail on a machine where signing is on).
 */
export async function makeGitRepo(files: Record<string, string>): Promise<{ root: string; baseSha: string }> {
  const root = await makeTmpRepo(files);
  await git(root, ["init", "-q"]);
  const baseSha = await commitAll(root, "base");
  return { root, baseSha };
}

/** Stage everything and commit it; returns the new commit's sha. */
export async function commitAll(root: string, message: string): Promise<string> {
  await git(root, ["add", "-A"]);
  await git(root, [
    "-c",
    "user.email=invariant@example.invalid",
    "-c",
    "user.name=invariant",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    message,
  ]);
  return (await git(root, ["rev-parse", "HEAD"])).trim();
}

/** Run git in `root`; a failure surfaces git's stderr instead of a bare exit code. */
async function git(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: root, encoding: "utf8" });
    return stdout;
  } catch (cause) {
    const stderr = typeof cause === "object" && cause !== null ? (cause as { stderr?: unknown }).stderr : undefined;
    const detail = typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim() : String(cause);
    throw new Error(`fixture: git ${args.join(" ")} failed: ${detail}`);
  }
}
