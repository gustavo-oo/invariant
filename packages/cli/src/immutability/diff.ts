/**
 * Spec §8 stage 4 — immutability. A rule or a proof must not change in a
 * feature PR without the rule-change label (spec §12), so the diff between the
 * base and the head is checked against the configured protected paths.
 *
 * A pure function: it sees the changed files, never runs git and never reads
 * the event. The caller owns both, which makes the decision table testable
 * without a repository.
 *
 * The zip tie: outside a pull request protected changes are still *recorded*
 * (a push to main is the audit trail of what was flagged), but never fail. Only
 * a `pr` context can return a finding, and only when the label is absent.
 */
import type { CiContext } from "../ci/event.js";
import type { Config } from "../config/model.js";
import { toPosix } from "../fsutil.js";
import type { Finding } from "../registry/model.js";

/** The decision table's output; `finding` is the only thing that changes an exit code. */
export interface ImmutabilityResult {
  finding: Finding | null;
  protectedPathsChanged: string[];
  flagged: boolean;
}

export interface ImmutabilityInput {
  /** Repo-relative, POSIX-separated paths from the diff. */
  changed: string[];
  config: Config;
  context: CiContext;
  /**
   * The protected entries to match: a trailing `/` means a directory prefix,
   * anything else is an exact file path. Passed explicitly (rather than read
   * from `config`) so the caller can narrow the set.
   */
  protectedPaths: string[];
}

/** Spec §12: a rule change in a feature PR is a product verdict (exit 1). */
export const PROTECTED_PATH_CHANGED = "immutability.protected_path_changed";

/**
 * Classify a diff against the protected paths.
 *
 * - `pr` + a protected change + no label → one `immutability.protected_path_changed` finding.
 * - `pr` + a protected change + the label → recorded, `flagged: true`, no finding.
 * - `push` / `merge_group` / `local` → recorded, never a finding; `flagged` still
 *   reflects the labels the event carried.
 */
export function immutabilityFinding(input: ImmutabilityInput): ImmutabilityResult {
  const { changed, config, context } = input;
  const label = config.ruleChange.label;
  const flagged = context.labels.includes(label);
  const protectedPathsChanged = protectedSubset(changed, input.protectedPaths);

  if (context.mode !== "pr" || protectedPathsChanged.length === 0 || flagged) {
    return { finding: null, protectedPathsChanged, flagged };
  }

  const listed = protectedPathsChanged.join(", ");
  const noun = protectedPathsChanged.length === 1 ? "path" : "paths";
  return {
    finding: {
      code: PROTECTED_PATH_CHANGED,
      message: `protected ${noun} changed without the "${label}" label: ${listed}`,
      file: protectedPathsChanged[0] ?? "(unknown file)",
    },
    protectedPathsChanged,
    flagged,
  };
}

/** The sorted, de-duplicated protected subset of `changed`. */
function protectedSubset(changed: string[], protectedPaths: string[]): string[] {
  const entries = protectedPaths.map(normalize).filter((entry) => entry !== "");
  const matches = changed.map(normalize).filter((file) => file !== "" && entries.some((entry) => covers(entry, file)));
  return [...new Set(matches)].sort();
}

/**
 * `rules/` covers `rules/sales.yaml` but not a file named `rules`; the workflow
 * and CODEOWNERS entries are exact, so `…/invariant.yml.bak` is not protected.
 */
function covers(entry: string, file: string): boolean {
  return entry.endsWith("/") ? file.startsWith(entry) : file === entry;
}

/** Repo-relative, POSIX-separated, without a leading `./` — in and out. */
function normalize(file: string): string {
  const posix = toPosix(file);
  return posix.startsWith("./") ? posix.slice(2) : posix;
}
