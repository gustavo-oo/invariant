import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Write `files` (repo-relative path -> content) into a fresh temporary
 * directory and return the **realpath** of its root, so macOS's
 * `/private/var/...` prefix never leaks into an assertion. Later tasks extend
 * this into richer fixtures.
 */
export async function makeTmpRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "invariant-repo-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return await realpath(root);
}
