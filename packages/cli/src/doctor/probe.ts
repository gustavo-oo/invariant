/**
 * Resolve the GitHub repository the forge probe should observe.
 *
 * In Actions `GITHUB_REPOSITORY` is always set; locally the origin remote is
 * the only source. A missing identity is not an error: the probe returns an
 * unavailable observation and `doctor` reports the class it can prove.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RepoIdentity {
  owner: string;
  name: string;
}

export async function resolveRepo(root: string): Promise<RepoIdentity | null> {
  const fromEnv = parseRepo(process.env["GITHUB_REPOSITORY"]);
  if (fromEnv !== null) return fromEnv;

  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf8",
    });
    return parseRemote(String(stdout).trim());
  } catch {
    return null;
  }
}

/** `owner/name` from the Actions environment. */
export function parseRepo(value: string | undefined): RepoIdentity | null {
  if (value === undefined) return null;
  const parts = value.split("/");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return null;
  return { owner: parts[0] as string, name: parts[1] as string };
}

/** `git@host:owner/name.git` or `https://host/owner/name(.git)`. */
export function parseRemote(url: string): RepoIdentity | null {
  if (url === "") return null;
  const patterns = [
    /^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?\/?$/,
    /^ssh:\/\/git@[^/]+\/([^/]+)\/(.+?)(?:\.git)?\/?$/,
    /^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?\/?$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(url);
    if (match !== null && match[1] !== undefined && match[2] !== undefined) {
      return { owner: match[1], name: match[2] };
    }
  }
  return null;
}
