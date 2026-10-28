/**
 * The CI event, read from GitHub's event JSON (`--event <path>` or
 * `GITHUB_EVENT_PATH`).
 *
 * ### Why this never throws
 *
 * `readEvent` runs before anything useful can happen, on whatever file CI
 * handed the process. A missing, unreadable or malformed event — or an event
 * this verifier does not understand, such as `push` or `workflow_dispatch` — is
 * not a crash and not a gate error: it is simply a run with no pull-request
 * context. The caller then has no base/head/labels, so it cannot claim to have
 * checked immutability, and `immutabilityFinding` never fails outside a
 * pull-request context. Fail-closed behaviour lives where the decision is made,
 * not in parsing.
 */
import { readText } from "../fsutil.js";

/** The mode a report records; only `pr` can fail an immutability check. */
export type CiMode = "local" | "pr" | "push" | "merge_group";

/**
 * The CI facts immutability and the report need. `base`/`head` are refs, not
 * verified commits; `labels` are the pull request's current labels.
 */
export interface CiContext {
  mode: CiMode;
  base: string | null;
  head: string | null;
  repo: string | null;
  runId: string | null;
  labels: string[];
}

/** The context for a run with no (usable) event. */
const LOCAL: CiContext = { mode: "local", base: null, head: null, repo: null, runId: null, labels: [] };

/**
 * Read the event at `path`, or at `GITHUB_EVENT_PATH` when no explicit path was
 * given. Total: every failure yields `LOCAL`.
 */
export async function readEvent(path: string | undefined): Promise<CiContext> {
  const file = path ?? process.env["GITHUB_EVENT_PATH"];
  if (file === undefined || file === "") return { ...LOCAL, labels: [] };

  let payload: unknown;
  try {
    payload = JSON.parse(await readText(file));
  } catch {
    return { ...LOCAL, labels: [] };
  }
  if (!isRecord(payload)) return { ...LOCAL, labels: [] };

  const repo = stringAt(payload, ["repository", "full_name"]);
  const runId = runIdAt(payload["run_id"]);
  const pullRequest = payload["pull_request"];
  if (isRecord(pullRequest)) {
    return {
      mode: "pr",
      base: stringAt(pullRequest, ["base", "sha"]),
      head: stringAt(pullRequest, ["head", "sha"]),
      repo,
      runId,
      labels: labelsOf(pullRequest["labels"]),
    };
  }

  const mergeGroup = payload["merge_group"];
  if (isRecord(mergeGroup)) {
    return { mode: "merge_group", base: null, head: stringAt(mergeGroup, ["head_sha"]), repo, runId, labels: [] };
  }

  return { ...LOCAL, labels: [] };
}

/** A non-string label name is skipped: it cannot be the configured label. */
function labelsOf(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  const names: string[] = [];
  for (const label of labels) {
    const name = isRecord(label) ? label["name"] : undefined;
    if (typeof name === "string") names.push(name);
  }
  return names;
}

/** GitHub sends `run_id` as a number; the report carries it as a string. */
function runIdAt(runId: unknown): string | null {
  if (typeof runId === "number") return String(runId);
  if (typeof runId === "string") return runId;
  return null;
}

/** Follow `keys` through nested records and return the value when it is a non-empty string. */
function stringAt(value: Record<string, unknown>, keys: [string, ...string[]]): string | null {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === "string" && current !== "" ? current : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
