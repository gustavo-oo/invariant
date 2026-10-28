/**
 * The one consumer of a `--doctor-result` artifact (R61). `verdict` and
 * `verify` must agree about the class, so both read the artifact here instead
 * of each carrying a parser that could drift.
 *
 * R52: the plan's `DoctorResult` is **flat** (plan line 1371): the observation
 * carries its own availability and the findings carry a severity. Anything that
 * does not match that shape — including the nested `{doctor: {...}}` envelope an
 * earlier revision invented — is unusable, because a class read from it would be
 * a claim about a document nothing in the pipeline produces.
 *
 * `ran` is `observation.available`, and only `severity: "fail"` findings reach
 * `computeClass`: `info` findings describe the observation (a merge queue whose
 * state is unknown, for instance) and must not lower the class.
 *
 * The envelope is the artifact's own top-level `repo`/`run_id`. A missing
 * expectation is as unverifiable as a disagreeing one: without it a stale
 * artifact from another run could still yield G1.
 */
import path from "node:path";
import { readText, toPosix } from "../fsutil.js";
import type { ClassFinding } from "../guarantee/class.js";
import type { Finding } from "../registry/model.js";

/** What the class decision may use, plus the finding that explains an unusable file. */
export interface DoctorEvidence {
  /** `observation.available`, and false for every unusable artifact. */
  ran: boolean;
  observation: "available" | "unavailable";
  /** The artifact's `severity: "fail"` findings, the only input `computeClass` sees. */
  findings: ClassFinding[];
  /** `doctor.result_mismatch` when the envelope or the file is unusable. */
  finding: Finding | null;
}

export interface DoctorEvidenceInput {
  /** The supplied path, or null when no `--doctor-result` was given. */
  doctorResult: string | null;
  /** The expected repository (`--repo`); a missing expectation is unverifiable. */
  repo: string | null;
  /** The expected run id (`--run-id`), checked the same way. */
  runId: string | null;
  /** Base for the relative `doctorResult` path: the repo root or the process cwd. */
  cwd: string;
}

/** Read the doctor artifact; never throws, never raises the class. */
export async function readDoctorEvidence(input: DoctorEvidenceInput): Promise<DoctorEvidence> {
  if (input.doctorResult === null) {
    return { ran: false, observation: "unavailable", findings: [], finding: null };
  }

  const file = toPosix(input.doctorResult);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readText(path.resolve(input.cwd, input.doctorResult)));
  } catch (cause) {
    return unusableDoctor(
      file,
      isNotFound(cause)
        ? "doctor result not found"
        : `doctor result is unreadable or not valid JSON: ${errorMessage(cause)}`,
    );
  }

  const doctor = doctorShape(parsed);
  if (doctor === null) {
    return unusableDoctor(
      file,
      "doctor result is not a flat DoctorResult {schema_version, repo, run_id, class, reasons, findings, observation}",
    );
  }

  const problems = envelopeProblems(parsed as Record<string, unknown>, input);
  if (problems.length > 0) {
    // Unverifiable, never G1: the findings were read from a result this run
    // cannot attribute to itself, so the class is computed without them.
    return {
      ran: false,
      observation: "unavailable",
      findings: [],
      finding: { code: "doctor.result_mismatch", message: problems.join("; "), file },
    };
  }

  return {
    ran: doctor.available,
    observation: doctor.available ? "available" : "unavailable",
    findings: doctor.findings,
    finding: null,
  };
}

function unusableDoctor(file: string, message: string): DoctorEvidence {
  return {
    ran: false,
    observation: "unavailable",
    findings: [],
    finding: { code: "doctor.result_mismatch", message, file },
  };
}

function envelopeProblems(artifact: Record<string, unknown>, input: DoctorEvidenceInput): string[] {
  const problems: string[] = [];
  if (input.repo === null) {
    problems.push(
      "--doctor-result was supplied without --repo, so the observation cannot be attributed to this repository",
    );
  } else {
    const actual = artifact["repo"];
    if (typeof actual !== "string") {
      problems.push(`doctor result has no repo, expected ${JSON.stringify(input.repo)}`);
    } else if (actual !== input.repo) {
      problems.push(`doctor result repo is ${JSON.stringify(actual)}, expected ${JSON.stringify(input.repo)}`);
    }
  }
  if (input.runId === null) {
    problems.push(
      "--doctor-result was supplied without --run-id, so a stale observation cannot be ruled out",
    );
  } else {
    const actual = artifact["run_id"];
    if (typeof actual !== "string") {
      problems.push(`doctor result has no run_id, expected ${JSON.stringify(input.runId)}`);
    } else if (actual !== input.runId) {
      problems.push(`doctor result run_id is ${JSON.stringify(actual)}, expected ${JSON.stringify(input.runId)}`);
    }
  }
  return problems;
}

interface DoctorShape {
  available: boolean;
  findings: ClassFinding[];
}

/** The flat `DoctorResult` guard; `null` means the document is unusable. */
function doctorShape(value: unknown): DoctorShape | null {
  if (!isRecord(value)) return null;
  if (value["schema_version"] !== 1) return null;
  if (!isNullableString(value["repo"])) return null;
  if (!isNullableString(value["run_id"])) return null;
  if (!isClass(value["class"])) return null;
  if (!Array.isArray(value["reasons"]) || !value["reasons"].every((reason) => typeof reason === "string")) {
    return null;
  }
  if (!Array.isArray(value["findings"])) return null;
  const findings: ClassFinding[] = [];
  for (const finding of value["findings"]) {
    if (!isRecord(finding) || typeof finding["code"] !== "string" || typeof finding["message"] !== "string") {
      return null;
    }
    const severity = finding["severity"];
    if (severity !== "fail" && severity !== "info") return null;
    if (severity === "fail") findings.push({ code: finding["code"], message: finding["message"] });
  }

  const observation = value["observation"];
  if (!isRecord(observation) || typeof observation["available"] !== "boolean") return null;
  if (observation["available"]) {
    if (!isRecord(observation["repo"]) || !isRecord(observation["protection"])) return null;
  } else if (typeof observation["reason"] !== "string") {
    return null;
  }

  return { available: observation["available"], findings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isClass(value: unknown): value is "G1" | "G2" | "G3" {
  return value === "G1" || value === "G2" || value === "G3";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNotFound(cause: unknown): boolean {
  return cause instanceof Error && (cause as NodeJS.ErrnoException).code === "ENOENT";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
