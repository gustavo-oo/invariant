import { symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The workspace's own install. Resolved from this file's URL, never from
 * `process.cwd()`: a fixture must work whatever directory the suite is run
 * from, and it must not depend on the repository being the cwd.
 */
const NODE_MODULES = fileURLToPath(new URL("../../../../node_modules", import.meta.url));

/**
 * Make the workspace install available to a throw-away repo without copying it
 * or running an install. The one implementation both `makeVitestRepo` and
 * `runFixture` use, so a fixture can execute Vitest offline the same way a
 * hand-built test repo does.
 */
export async function linkNodeModules(root: string): Promise<void> {
  await symlink(NODE_MODULES, path.join(root, "node_modules"), "dir");
}
