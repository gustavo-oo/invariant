/**
 * GitHub REST observation for `doctor` (spec §9.2/§9.3).
 *
 * `observeFromApi` is total: a missing token, a non-2xx response, a malformed
 * payload or a thrown fetch all become `{ available: false, reason }`, never an
 * exception. `doctor` may therefore run offline and still report the class it
 * can prove.
 *
 * A ruleset is selected only when it targets `branch`, is `active`, and its
 * `conditions.ref_name.include` covers the default branch. Classic branch
 * protection is preferred when it already carries a required check (spec §9.3
 * accepts either mechanism); otherwise the active ruleset is used.
 */
import type { DoctorObservation } from "../seams/forge-probe.js";

export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<FetchResponse>;

export interface GitHubTarget {
  owner: string;
  name: string;
  token: string | null;
  /** API root; defaults to https://api.github.com. */
  apiUrl?: string;
}

type Protection = Extract<DoctorObservation, { available: true }>["protection"];

interface ApiOk {
  ok: true;
  data: unknown;
}

interface ApiError {
  ok: false;
  status: number;
  path: string;
}

export async function observeFromApi(
  fetchImpl: FetchLike,
  target: GitHubTarget,
): Promise<DoctorObservation> {
  if (target.token === null || target.token.trim() === "") {
    return { available: false, reason: "no token provided" };
  }

  const api = (target.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const base = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}`;

  try {
    const repo = await get(fetchImpl, api, base, target.token);
    if (!repo.ok) return unavailable(repo);
    const info = record(repo.data);
    if (info === null || stringOf(info["default_branch"]) === undefined) {
      return { available: false, reason: "repository response has no default_branch" };
    }

    const defaultBranch = stringOf(info["default_branch"]) as string;
    const owner = stringOf(record(info["owner"])?.["login"]) ?? target.owner;
    const name = stringOf(info["name"]) ?? target.name;
    const visibility = info["visibility"] === "public" ? "public" : "private";

    const ruleset = await readRuleset(fetchImpl, api, base, defaultBranch, target.token);
    if (ruleset.kind === "error") return { available: false, reason: ruleset.reason };

    const classic = await readClassic(fetchImpl, api, base, defaultBranch, target.token);
    if (classic.kind === "error") return { available: false, reason: classic.reason };

    let protection: Protection;
    if (classic.kind === "classic" && classic.protection.requiredContexts.length > 0) {
      // Spec §9.3 accepts either mechanism; classic wins when it carries the check.
      protection = classic.protection;
    } else if (ruleset.kind === "ruleset") {
      protection = ruleset.protection;
    } else if (classic.kind === "classic") {
      protection = classic.protection;
    } else {
      protection = noneProtection();
    }

    return {
      available: true,
      repo: { owner, name, defaultBranch, visibility },
      protection,
    };
  } catch (cause) {
    return {
      available: false,
      reason: `GitHub probe failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

type RulesetRead =
  | { kind: "ruleset"; protection: Protection }
  | { kind: "none" }
  | { kind: "error"; reason: string };

async function readRuleset(
  fetchImpl: FetchLike,
  api: string,
  base: string,
  defaultBranch: string,
  token: string,
): Promise<RulesetRead> {
  const list = await get(fetchImpl, api, `${base}/rulesets`, token);
  // A repo with no rulesets returns 200 []; 404 is also "none" so a token that
  // cannot see rulesets still allows classic protection to be read.
  if (!list.ok) {
    if (list.status === 404) return { kind: "none" };
    return { kind: "error", reason: describe(list) };
  }
  if (!Array.isArray(list.data)) {
    return { kind: "error", reason: "rulesets response is not an array" };
  }

  for (const entry of list.data) {
    const summary = record(entry);
    if (summary === null || summary["target"] !== "branch" || summary["enforcement"] !== "active") {
      continue;
    }
    const id = numberOf(summary["id"]);
    if (id === null) continue;

    const detail = await get(fetchImpl, api, `${base}/rulesets/${id}`, token);
    if (!detail.ok) {
      // A listed ruleset that disappeared between calls is not a readable
      // observation; fail closed instead of claiming "none".
      return { kind: "error", reason: describe(detail) };
    }
    const value = record(detail.data);
    if (value === null) continue;
    if (!coversDefaultBranch(value["conditions"], defaultBranch)) continue;

    return { kind: "ruleset", protection: protectionFromRuleset(value) };
  }

  return { kind: "none" };
}

type ClassicRead =
  | { kind: "classic"; protection: Protection }
  | { kind: "none" }
  | { kind: "error"; reason: string };

async function readClassic(
  fetchImpl: FetchLike,
  api: string,
  base: string,
  defaultBranch: string,
  token: string,
): Promise<ClassicRead> {
  const path = `${base}/branches/${encodeURIComponent(defaultBranch)}/protection`;
  const response = await get(fetchImpl, api, path, token);
  // 404 is the normal "no classic protection" answer.
  if (!response.ok) {
    if (response.status === 404) return { kind: "none" };
    return { kind: "error", reason: describe(response) };
  }
  const value = record(response.data);
  if (value === null) return { kind: "error", reason: "branch protection response is not an object" };
  return { kind: "classic", protection: protectionFromClassic(value) };
}

function protectionFromRuleset(value: Record<string, unknown>): Protection {
  const rules = arrayOf(value["rules"]).map(record).filter(isRecord);
  const required = ruleOf(rules, "required_status_checks");
  const checks = arrayOf(record(required?.["parameters"])?.["required_status_checks"]);
  const pull = record(ruleOf(rules, "pull_request")?.["parameters"]);

  return {
    mechanism: "ruleset",
    requiredContexts: checks
      .map(record)
      .filter(isRecord)
      .map((check) => ({
        context: stringOf(check["context"]) ?? "",
        appId: numberOrNull(check["integration_id"] ?? check["app_id"]),
      }))
      .filter((check) => check.context !== ""),
    codeOwnerReview: pull?.["require_code_owner_review"] === true,
    bypassActors: arrayOf(value["bypass_actors"])
      .map(record)
      .filter(isRecord)
      .map((actor) => ({
        type: stringOf(actor["actor_type"]) ?? "unknown",
        id: numberOrNull(actor["actor_id"]),
        mode: stringOf(actor["bypass_mode"]) ?? "unknown",
      })),
    mergeQueue: rules.some((rule) => rule["type"] === "merge_queue") ? "enabled" : "unknown",
  };
}

function protectionFromClassic(value: Record<string, unknown>): Protection {
  const required = record(value["required_status_checks"]);
  const checks = arrayOf(required?.["checks"])
    .map(record)
    .filter(isRecord)
    .map((check) => ({
      context: stringOf(check["context"]) ?? "",
      appId: numberOrNull(check["app_id"]),
    }))
    .filter((check) => check.context !== "");
  const contexts = arrayOf(required?.["contexts"])
    .filter((context): context is string => typeof context === "string")
    .map((context) => ({ context, appId: null }));

  const reviews = record(value["required_pull_request_reviews"]);
  const enforceAdmins = record(value["enforce_admins"]);
  const adminBypass =
    enforceAdmins !== null && enforceAdmins["enabled"] === false
      ? [{ type: "Admin", id: null, mode: "always" }]
      : [];

  return {
    mechanism: "branch-protection",
    requiredContexts: [...checks, ...contexts],
    codeOwnerReview:
      reviews?.["require_code_owner_reviews"] === true ||
      reviews?.["require_code_owner_review"] === true,
    bypassActors: adminBypass,
    mergeQueue: "unknown",
  };
}

function coversDefaultBranch(conditions: unknown, defaultBranch: string): boolean {
  const refName = record(record(conditions)?.["ref_name"]);
  const include = arrayOf(refName?.["include"]).filter(
    (value): value is string => typeof value === "string",
  );
  return (
    include.includes("~DEFAULT_BRANCH") ||
    include.includes("~ALL") ||
    include.includes(defaultBranch) ||
    include.includes(`refs/heads/${defaultBranch}`)
  );
}

function noneProtection(): Protection {
  return {
    mechanism: "none",
    requiredContexts: [],
    codeOwnerReview: false,
    bypassActors: [],
    mergeQueue: "unknown",
  };
}

async function get(fetchImpl: FetchLike, api: string, path: string, token: string): Promise<ApiOk | ApiError> {
  try {
    const response = await fetchImpl(`${api}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "invariant",
      },
    });
    if (!response.ok) return { ok: false, status: response.status, path };
    return { ok: true, data: await response.json() };
  } catch (cause) {
    return {
      ok: false,
      status: 0,
      path: `${path} (${cause instanceof Error ? cause.message : String(cause)})`,
    };
  }
}

function unavailable(error: ApiError): DoctorObservation {
  return { available: false, reason: describe(error) };
}

function describe(error: ApiError): string {
  return `GitHub API ${error.path} returned ${error.status === 0 ? "no response" : error.status}`;
}

function ruleOf(rules: Record<string, unknown>[], type: string): Record<string, unknown> | undefined {
  return rules.find((rule) => rule["type"] === type);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isRecord(value: Record<string, unknown> | null): value is Record<string, unknown> {
  return value !== null;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return numberOf(value);
}
