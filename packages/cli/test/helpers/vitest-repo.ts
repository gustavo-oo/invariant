import { symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTmpRepo } from "./fixture.js";

/**
 * The workspace's own install. Resolved from this file's URL, never from
 * `process.cwd()`: the fixture must work whatever directory the suite is run
 * from, and it must not depend on the repository being the cwd.
 */
const NODE_MODULES = fileURLToPath(new URL("../../../../node_modules", import.meta.url));

/**
 * A temporary repo whose tests can actually run under Vitest offline. It has
 * `makeTmpRepo` semantics (fresh temp dir, realpath returned, caller's files
 * copied only) plus a `node_modules` symlink to the workspace install: no copy,
 * no install step, and nothing is ever written into the repository.
 */
export async function makeVitestRepo(files: Record<string, string>): Promise<string> {
  const root = await makeTmpRepo(files);
  await symlink(NODE_MODULES, path.join(root, "node_modules"), "dir");
  return root;
}
