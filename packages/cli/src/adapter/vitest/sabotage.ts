/**
 * Vitest's `applySabotage`: copy-and-replace the module named by the sabotage's
 * `@seam-alias`, run the target check, and classify what happened.
 *
 * The workdir is already an isolated copy; the caller owns its cleanup. A
 * replacement that cannot be installed, a check that stays green, an absent
 * result and a check that was filtered out are all `not-applied` — never proof.
 * A run-level failure (no readable report, spawn failure) throws, so the
 * executor can turn it into a gate error instead of a product verdict.
 */
import { realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SabotageOutcome } from "../../verdict/types.js";
import type { SabotageSpec } from "../api.js";
import { classifyFailureMessage } from "../failure.js";
import { runChecks } from "./run.js";

export async function applyVitestSabotage(spec: SabotageSpec): Promise<SabotageOutcome> {
  const target = path.join(spec.workdir, spec.seamAlias);
  if (!(await isFileInside(spec.workdir, target))) return { status: "not-applied" };

  try {
    await writeFile(target, spec.sabotageText, "utf8");
  } catch {
    return { status: "not-applied" };
  }

  const [result] = await runChecks([spec.check], {
    root: spec.workdir,
    env: spec.env,
    timeoutMs: spec.timeoutMs ?? 120_000,
  });

  if (result === undefined || result.outcome === "pass") return { status: "not-applied" };
  if (result.outcome === "not-run" && result.message === undefined) return { status: "not-applied" };

  return { status: "applied", classification: classifyFailureMessage(result.outcome, result.message) };
}

/**
 * Resolve both paths before writing: a target symlink that escapes the sandbox
 * must not be followed back into the real tree.
 */
async function isFileInside(root: string, target: string): Promise<boolean> {
  try {
    const realRoot = await realpath(root);
    const realTarget = await realpath(target);
    const relative = path.relative(realRoot, realTarget);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
    return (await stat(realTarget)).isFile();
  } catch {
    return false;
  }
}
