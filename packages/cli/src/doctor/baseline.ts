/**
 * The protection baseline (spec §9.3, PEND-6).
 *
 * The baseline is the recorded environment the next run must not get weaker
 * than: its class, the required check name/App, the protected paths and the
 * bypass list. An absent file is a fresh repository, never a block: it yields a
 * synthetic G3 baseline with the documented defaults. A malformed file is not
 * silently ignored — it yields the default plus a `baseline.unreadable` finding
 * for the caller to publish.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CONFIG } from "../config/model.js";
import type { GuaranteeClass } from "../guarantee/class.js";
import type { DoctorFinding } from "./checks.js";

export const BASELINE_PATH = ".invariant/protection-baseline.json";

export interface BaselineBypassActor {
  type: string;
  id: number | null;
  mode: string;
}

export interface BaselineExpected {
  required_context: string;
  required_context_app_id: number;
  protected_paths: string[];
  bypass_actors: BaselineBypassActor[];
}

export interface Baseline {
  schema_version: 1;
  recorded_class: GuaranteeClass;
  expected: BaselineExpected;
}

export function defaultBaseline(config = DEFAULT_CONFIG): Baseline {
  return {
    schema_version: 1,
    recorded_class: "G3",
    expected: {
      required_context: "invariant-verdict",
      required_context_app_id: config.doctor.expectedAppId,
      protected_paths: [...config.protectedPaths],
      bypass_actors: [],
    },
  };
}

export interface BaselineRead {
  baseline: Baseline;
  /** `baseline.unreadable` when the file exists but cannot be used. */
  findings: DoctorFinding[];
}

export async function readBaseline(root: string): Promise<BaselineRead> {
  const file = path.join(root, BASELINE_PATH);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (cause) {
    if (isNotFound(cause)) return { baseline: defaultBaseline(), findings: [] };
    return {
      baseline: defaultBaseline(),
      findings: [unreadable(`cannot read ${BASELINE_PATH}: ${messageOf(cause)}`)],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return {
      baseline: defaultBaseline(),
      findings: [unreadable(`${BASELINE_PATH} is not valid JSON: ${messageOf(cause)}`)],
    };
  }

  const baseline = baselineShape(parsed);
  if (baseline === null) {
    return {
      baseline: defaultBaseline(),
      findings: [
        unreadable(
          `${BASELINE_PATH} must carry schema_version 1, recorded_class G1/G2/G3 and the expected protection attributes`,
        ),
      ],
    };
  }
  return { baseline, findings: [] };
}

export async function writeBaseline(root: string, baseline: Baseline): Promise<void> {
  const file = path.join(root, BASELINE_PATH);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, renderBaseline(baseline), "utf8");
}

export function renderBaseline(baseline: Baseline): string {
  return JSON.stringify(baseline, null, 2) + "\n";
}

function unreadable(message: string): DoctorFinding {
  return { code: "baseline.unreadable", severity: "fail", message };
}

function baselineShape(value: unknown): Baseline | null {
  const record = asRecord(value);
  if (record === null) return null;
  if (record["schema_version"] !== 1) return null;
  const recorded = record["recorded_class"];
  if (recorded !== "G1" && recorded !== "G2" && recorded !== "G3") return null;

  const expected = asRecord(record["expected"]);
  if (expected === null) return null;
  const requiredContext = expected["required_context"];
  const appId = expected["required_context_app_id"];
  const protectedPaths = expected["protected_paths"];
  const bypass = expected["bypass_actors"];
  if (typeof requiredContext !== "string" || requiredContext === "") return null;
  if (typeof appId !== "number" || !Number.isFinite(appId)) return null;
  if (!Array.isArray(protectedPaths) || !protectedPaths.every((item) => typeof item === "string")) {
    return null;
  }
  if (!Array.isArray(bypass)) return null;

  const bypassActors: BaselineBypassActor[] = [];
  for (const actor of bypass) {
    const item = asRecord(actor);
    if (
      item === null ||
      typeof item["type"] !== "string" ||
      (item["id"] !== null && typeof item["id"] !== "number") ||
      typeof item["mode"] !== "string"
    ) {
      return null;
    }
    bypassActors.push({ type: item["type"], id: item["id"] as number | null, mode: item["mode"] });
  }

  return {
    schema_version: 1,
    recorded_class: recorded,
    expected: {
      required_context: requiredContext,
      required_context_app_id: appId,
      protected_paths: [...protectedPaths],
      bypass_actors: bypassActors,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isNotFound(cause: unknown): boolean {
  return cause instanceof Error && (cause as NodeJS.ErrnoException).code === "ENOENT";
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
