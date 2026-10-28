/**
 * The changed-files seam (SELF-003). Immutability is only as trustworthy as the
 * diff it reads, so this module owns the one place the CLI shells out to git.
 *
 * The seam never returns a partial list: a git failure either becomes an empty
 * diff *for a known reason* (the base does not exist locally and a shallow
 * fetch could not produce it — that retry is attempted once) or an error the
 * caller turns into a gate finding. A half-read diff must never be mistaken for
 * "nothing protected changed".
 *
 * No shell: `execFile` with an argument vector, so a ref can never be re-parsed
 * as a command.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { toPosix } from "../fsutil.js";

const execFileAsync = promisify(execFile);

/** What the caller needs to know: which files, and which refs produced them. */
export interface ChangedFiles {
  /** Sorted, de-duplicated, repo-relative POSIX paths. */
  files: string[];
  base: string;
  head: string;
}

export interface ChangedFilesProvider {
  changedFiles(root: string, base: string, head: string): Promise<ChangedFiles>;
}

/** Git's wording when the base commit is not in the local object database. */
const UNKNOWN_BASE =
  /unknown revision|bad revision|not a valid object name|bad object|needed a single revision|ambiguous argument/i;

/** The production seam: a real `git` process, never a shell. */
export function createChangedFilesProvider(): ChangedFilesProvider {
  return {
    async changedFiles(root: string, base: string, head: string): Promise<ChangedFiles> {
      assertRef(base, "base");
      assertRef(head, "head");
      const range = `${base}...${head}`;
      const args = ["diff", "--name-only", "--no-renames", "-z", range];

      let stdout: string;
      try {
        stdout = await git(root, args);
      } catch (cause) {
        // A shallow or fresh checkout may not know the base yet: fetch that one
        // commit and retry the same diff exactly once.
        if (!UNKNOWN_BASE.test(errorMessage(cause))) throw cause;
        await git(root, ["fetch", "--depth=1", "origin", base]);
        stdout = await git(root, args);
      }

      const files = [...new Set(stdout.split("\0").filter((file) => file !== "").map(toPosix))].sort();
      return { files, base, head };
    },
  };
}

/**
 * A ref reaches git as one argument, but `-`-prefixed input would still be read
 * as an option by `git diff`, where `--` cannot be used (it turns the range
 * into a pathspec). Refuse it instead of guessing.
 */
function assertRef(ref: string, name: string): void {
  if (ref === "" || ref.startsWith("-")) {
    throw new Error(`invariant: invalid ${name} ref: ${JSON.stringify(ref)}`);
  }
}

/** Run git in `root` and return stdout; any failure carries git's stderr. */
async function git(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: root, encoding: "utf8" });
    return stdout;
  } catch (cause) {
    throw new Error(`git ${args.join(" ")} failed: ${gitStderr(cause)}`);
  }
}

/** `execFile` attaches stderr; fall back to the message when it is empty. */
function gitStderr(cause: unknown): string {
  if (typeof cause === "object" && cause !== null) {
    const stderr = (cause as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim() !== "") return stderr.trim();
  }
  return errorMessage(cause);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
