/**
 * The CI event, read from GitHub's event JSON (`--event <path>` or
 * `GITHUB_EVENT_PATH`).
 *
 * ### Total, but not silent
 *
 * `readEvent` never throws: it runs before anything useful can happen, on
 * whatever file CI handed the process, and a crash there would hide the real
 * problem. It does, however, report *why* it has no pull-request context
 * (`eventStatus`), because "no event was supplied" and "the event you supplied
 * is broken" are different situations: the first is a legitimate local audit,
 * the second must not silently skip PR enforcement (R58). The caller decides;
 * this module only tells the truth about what it read.
 */
import { readText } from "../fsutil.js";

/** The mode a report records; only `pr` can fail an immutability check. */
export type CiMode = "local" | "pr" | "push" | "merge_group";

/**
 * How the event was obtained:
 * - `parsed` — a JSON object was read (a `push` payload still maps to `local`).
 * - `absent` — no path was supplied at all.
 * - `unreadable` — a path was supplied but could not be read or parsed as a
 *   JSON object.
 */
export type EventStatus = "parsed" | "absent" | "unreadable";

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
  eventStatus: EventStatus;
}

/**
 * Read the event at `path`, or at `GITHUB_EVENT_PATH` when no explicit path was
 * given. Total: every failure yields a `local` context carrying `eventStatus`.
 */
export async function readEvent(path: string | undefined): Promise<CiContext> {
  const file = path ?? process.env["GITHUB_EVENT_PATH"];
  if (file === undefined || file === "") return local("absent");

  let payload: unknown;
  try {
    payload = JSON.parse(await readText(file));
  } catch {
    return local("unreadable");
  }
  // JSON that is not an object (an array, a string, `null`) cannot describe an
  // event: treat it like malformed JSON rather than as "nothing to see".
  if (!isRecord(payload)) return local("unreadable");

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
      eventStatus: "parsed",
    };
  }

  const mergeGroup = payload["merge_group"];
  if (isRecord(mergeGroup)) {
    return {
      mode: "merge_group",
      base: null,
      head: stringAt(mergeGroup, ["head_sha"]),
      repo,
      runId,
      labels: [],
      eventStatus: "parsed",
    };
  }

  // A readable event this verifier does not act on (`push`, `workflow_dispatch`,
  // …): a local audit, not an error.
  return local("parsed");
}

/** A context with no usable event, tagged with why. */
function local(eventStatus: EventStatus): CiContext {
  return { mode: "local", base: null, head: null, repo: null, runId: null, labels: [], eventStatus };
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
