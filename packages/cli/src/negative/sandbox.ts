/**
 * The isolated copy a sabotaged check runs in (spec §7).
 *
 * A sandbox is a disposable copy of the repository with three guarantees:
 *
 * 1. **Secrets stay out.** `.env*`, key/certificate files, package-manager
 *    config and the repository's own `.git`/CI artifacts are excluded.
 * 2. **`node_modules` is a symlink farm, not a symlink.** The copy has a real
 *    `node_modules` directory whose top-level entries point at the install, so
 *    Vite's cache (`node_modules/.vite`) is written in the sandbox and never
 *    through a symlink back into the repository.
 * 3. **The environment is replaced, not merged.** `sanitizedEnv` drops the
 *    credential families, points `HOME` at the sandbox and loads the
 *    no-network preload for the child.
 *
 * The copy dereferences source symlinks (`dereference: true`) so a committed
 * symlink cannot write back into the original tree. Cleanup is the caller's
 * responsibility and is safe to call twice.
 */
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface Sandbox {
  /** Absolute root of the disposable copy. */
  root: string;
  cleanup(): Promise<void>;
}

/** Absolute path of the preload asset; `npm run build` copies it to dist/assets. */
export const NO_NETWORK_PRELOAD = fileURLToPath(
  new URL("../assets/negative/no-network.mjs", import.meta.url),
);

const PRELOAD_NAME = ".invariant-no-network.mjs";
const TMP_DIR = ".invariant-tmp";

const SKIP_NAMES = new Set([
  ".git",
  "node_modules",
  ".worktrees",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "invariant-report.json",
  "invariant-comment.md",
  "invariant-doctor.json",
  "invariant-inputs",
  "playwright-report",
  "test-results",
  "coverage",
]);

const SKIP_SUFFIXES = [".pem", ".key", ".p12", ".pfx"];

/** The credential-looking environment variables a sabotaged run must not see. */
const SECRET_KEY = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY|API_KEY|ACCESS_KEY|AUTH)(?:_|$)/i;
const SECRET_PREFIXES = [
  "GITHUB_",
  "GH_",
  "NPM_",
  "YARN_",
  "PNPM_",
  "AWS_",
  "AZURE_",
  "GOOGLE_",
  "INVARIANT_",
  "ACTIONS_",
  "RUNNER_",
];

/**
 * Copy `sourceRoot` into a fresh temp directory. `label` is a human hint for
 * the directory name; it is sanitized and never used as a path component.
 */
export async function createSandbox(sourceRoot: string, label: string): Promise<Sandbox> {
  const source = await realpath(sourceRoot);
  const holder = await mkdtemp(path.join(tmpdir(), "invariant-sandbox-"));
  const root = path.join(holder, safeLabel(label));

  try {
    await mkdir(root, { recursive: true });
    await cp(source, root, {
      recursive: true,
      // Follow source symlinks so a committed link cannot point back at the
      // real tree; the node_modules links are recreated explicitly below.
      dereference: true,
      filter: shouldCopy,
    });
    await linkNodeModules(source, root);
    await mkdir(path.join(root, TMP_DIR), { recursive: true });
    await copyFile(NO_NETWORK_PRELOAD, path.join(root, PRELOAD_NAME));
    return {
      root,
      async cleanup(): Promise<void> {
        await rm(holder, { recursive: true, force: true });
      },
    };
  } catch (cause) {
    await rm(holder, { recursive: true, force: true });
    throw cause;
  }
}

/**
 * The complete environment for a sabotaged child. Credential-looking variables
 * and every CI/package-manager prefix are removed; `HOME`, `USERPROFILE`,
 * `TMPDIR` and the preload all point into the sandbox.
 */
export function sanitizedEnv(base: NodeJS.ProcessEnv, sandboxRoot: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key === "NODE_OPTIONS") continue;
    if (SECRET_KEY.test(key)) continue;
    if (SECRET_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }

  env["HOME"] = sandboxRoot;
  env["USERPROFILE"] = sandboxRoot;
  env["TMPDIR"] = path.join(sandboxRoot, TMP_DIR);
  env["CI"] = "1";
  if (env["PATH"] === undefined) env["PATH"] = base["PATH"] ?? "";
  // Browser binaries are not credentials; preserve an explicit cache path.
  const browsers = base["PLAYWRIGHT_BROWSERS_PATH"];
  if (browsers !== undefined) env["PLAYWRIGHT_BROWSERS_PATH"] = browsers;

  // The preload is copied into the sandbox, so the child can load it without
  // resolving the CLI's own install.
  env["NODE_OPTIONS"] = `--import ${pathToFileURL(path.join(sandboxRoot, PRELOAD_NAME)).href}`;
  return env;
}

/** Whether a source entry may enter the sandbox. */
function shouldCopy(source: string): boolean {
  const base = path.basename(source);
  if (SKIP_NAMES.has(base)) return false;
  if (base === ".env" || base.startsWith(".env.")) return false;
  if (base.startsWith(".pnp.")) return false;
  if (SKIP_SUFFIXES.some((suffix) => base.endsWith(suffix))) return false;
  return true;
}

/**
 * Recreate every `node_modules` directory of the source as a real directory of
 * symlinks. A single symlinked `node_modules` would make Vite write its cache
 * through the link into the repository, so the farm is intentional.
 */
async function linkNodeModules(source: string, root: string): Promise<void> {
  for (const modules of await findNodeModules(source)) {
    const relative = path.relative(source, modules);
    await linkFarm(modules, path.join(root, relative));
  }
}

async function findNodeModules(source: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const full = path.join(directory, entry.name);
      if (entry.name === "node_modules") {
        found.push(full);
        continue;
      }
      if (entry.isDirectory()) await walk(full);
    }
  }

  await walk(source);
  return found;
}

async function linkFarm(sourceModules: string, destModules: string): Promise<void> {
  await mkdir(destModules, { recursive: true });
  let entries;
  try {
    entries = await readdir(sourceModules, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const target = path.join(sourceModules, entry.name);
    const link = path.join(destModules, entry.name);
    const directory = entry.isDirectory() || (await isDirectory(target));
    try {
      await symlink(target, link, directory ? "dir" : "file");
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw cause;
    }
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** A directory-safe label; never trusted as a path on its own. */
function safeLabel(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 64);
  return cleaned === "" ? "sandbox" : cleaned;
}

/** Exported for the test that pins the source/destination guard. */
export async function isSymlink(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isSymbolicLink();
  } catch {
    return false;
  }
}
