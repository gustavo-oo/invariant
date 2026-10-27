import { makeTmpRepo } from "./fixture.js";
import { linkNodeModules } from "./node-modules.js";

/**
 * A temporary repo whose tests can actually run under Vitest offline. It has
 * `makeTmpRepo` semantics (fresh temp dir, realpath returned, caller's files
 * copied only) plus a `node_modules` symlink to the workspace install: no copy,
 * no install step, and nothing is ever written into the repository.
 */
export async function makeVitestRepo(files: Record<string, string>): Promise<string> {
  const root = await makeTmpRepo(files);
  await linkNodeModules(root);
  return root;
}
