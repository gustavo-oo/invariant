import type { SabotageOutcome } from "../../verdict/types.js";
import type { SabotageSpec } from "../api.js";
import { applySabotageInCopy } from "../sabotage.js";
import { runChecks } from "./run.js";

/** Vitest's `applySabotage`: the shared copy-and-replace with `runChecks`. */
export async function applyVitestSabotage(spec: SabotageSpec): Promise<SabotageOutcome> {
  return applySabotageInCopy(spec, runChecks);
}
