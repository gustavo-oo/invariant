import { stat, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The workspace's own install. Resolved from this file's URL, never from
 * `process.cwd()`: a fixture must work whatever directory the suite is run
 * from, and it must not depend on the repository being the cwd.
 *
 * The install is hoisted to the workspace root (`node_modules/`), not
 * `packages/cli/node_modules/`; one symlink is enough because Node resolves the
 * realpath and finds every dependency inside the workspace.
 */
const NODE_MODULES = fileURLToPath(new URL("../../../../node_modules", import.meta.url));

/**
 * Make the workspace install available to a throw-away repo without copying it
 * or running an install. Idempotent: a second call on the same root is a no-op,
 * so `makeVitestRepo(files, { into })` can be called repeatedly. A fixture that
 * already created its own `node_modules` keeps it.
 */
export async function linkNodeModules(root: string): Promise<void> {
  const target = path.join(root, "node_modules");
  if (await exists(target)) return;
  await symlink(NODE_MODULES, target, "dir");
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (cause) {
    if (cause instanceof Error && (cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}
