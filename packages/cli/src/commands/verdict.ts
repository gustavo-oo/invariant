/**
 * `invariant verdict` — spec §9.4: the single aggregate check branch protection
 * requires, and the only job allowed to turn upstream facts into a verdict.
 *
 * The job fails **closed**. A cancelled, skipped, never-started or artifact-less
 * upstream job is red, and absence never means success: every expected job needs
 * an explicit `--job-status` entry *and*, when that entry is `success`, a
 * readable `stage-result.json`. Anything else is a gate finding (exit 2), never a
 * verdict about the product.
 *
 * The command rebuilds what the workers observed rather than trusting a worker's
 * exit code: it loads and §5-validates the registry, discovers the tagged tests
 * through the seam, maps the checks artifact onto those tests by `runtimeId`, and
 * rolls the result up with the one engine (`computeVerdicts`). Immutability and
 * event parsing are Task 12's; this command must not pretend it checked either.
 */
import path from "node:path";
import type { CheckResult } from "../adapter/api.js";
import { loadConfig } from "../config/load.js";
import type { DiscoveredCheck, DiscoveryError } from "../discovery/types.js";
import { EXIT, type ExitCode } from "../exit.js";
import { readText, toPosix } from "../fsutil.js";
import { computeClass, type ClassFinding, type GuaranteeClass } from "../guarantee/class.js";
import { stringifyJson, writeOut, type CliIo } from "../output.js";
import { loadRegistry } from "../registry/load.js";
import type { Finding } from "../registry/model.js";
import { validateRegistry } from "../registry/validate.js";
import { renderComment } from "../report/comment.js";
import type { DoctorSummary, NegativeControlMode } from "../report/shape.js";
import { buildReport } from "../report/write.js";
import { createDiscoverySource } from "../seams/discovery-source.js";
import { computeVerdicts } from "../verdict/compute.js";
import { TOOL_VERSION } from "../version.js";

const HELP = `invariant verdict - aggregate the upstream jobs into one fail-closed verdict

Usage:
  invariant verdict --inputs <dir> [--job-status <job>=<result>]... [--doctor-result <file>]
                    [--repo <owner/name>] [--run-id <id>] [--baseline <file>]
                    [--root <dir>] [--out <file>] [--comment <file>]

Options:
      --inputs <dir>          Directory holding <job>/stage-result.json for the
                              three upstream jobs. Required.
      --job-status <job>=...  The result GitHub reports for an upstream job.
                              Repeat once per job. A job with no entry is red.
      --doctor-result <file>  The doctor's JSON result; its observation decides
                              whether the class can be G1.
      --repo <owner/name>     Expected repository, checked against the doctor
                              result. A mismatch makes the observation unusable.
      --run-id <id>           Expected run id, checked the same way.
      --baseline <file>       A recorded {"recorded_class": "G1"|"G2"|"G3"}.
                              A lower class than the baseline is a gate failure.
      --root <dir>            Repository root (default: the current directory).
      --out <file>            Report path (default: invariant-report.json).
      --comment <file>        PR comment path (default: invariant-comment.md).
      --base <ref>            Accepted and ignored here; Task 12 derives mode,
                              base and head from the CI event.
      --head <sha>            Accepted and ignored for the same reason.
  -h, --help                  Print this help.

Fail-closed upstream contract:
  Exactly three jobs are expected: invariant-registry, invariant-checks and
  invariant-negative. Each is read from <inputs>/<job>/stage-result.json. A job
  with no --job-status entry, a cancelled or skipped job, any other non-success
  status, or a success job whose artifact is missing, unreadable, unparseable or
  the wrong shape is a gate failure. Absence is never success.

Exit codes:
  0  Every upstream artifact is green and every check, enforced rule and flow passed.
  1  The upstream artifacts are complete, but a check, enforced rule or flow did not pass.
  2  An upstream job is missing/cancelled/skipped/failed, an artifact is missing or
     malformed, discovery failed, the registry is invalid, or the class regressed
     against --baseline.
`;

/** The three worker jobs the CI contract fixes (R49), in aggregation order. */
const EXPECTED_JOBS: ReadonlyArray<{ stage: StageName; job: string }> = [
  { stage: "registry", job: "invariant-registry" },
  { stage: "checks", job: "invariant-checks" },
  { stage: "negative", job: "invariant-negative" },
];

const ARTIFACT = "stage-result.json";

/** A worker job's name, from its artifact's `stage` field. */
export type StageName = "registry" | "checks" | "negative";

/**
 * One upstream job's artifact. `checks` is the checks worker's `CheckResult[]`;
 * `negative` is the negative worker's declaration summary (PEND-1: nothing
 * executes sabotage in this delivery, so `executed` is false today).
 */
export interface StageResult {
  stage: StageName;
  job: string;
  exit_code: ExitCode;
  findings: Finding[];
  checks?: CheckResult[];
  negative?: { declared: number; executed: boolean; findings: Finding[] };
}

/** The outcomes a checks artifact may carry; anything else is a shape mismatch. */
const OUTCOMES: ReadonlySet<string> = new Set(["pass", "fail", "not-run", "flaky"]);
const CLASSIFICATIONS: ReadonlySet<string> = new Set(["assertion", "harness", "timeout"]);

/**
 * Read the three expected artifacts, cross-checked against `jobStatuses`.
 *
 * The status rule is the fail-closed core: a missing entry, `cancelled`,
 * `skipped`, `failure` or any other non-`success` value produces an
 * `upstream.*` finding and the artifact is **not** read — a non-success job is
 * never additionally required to have one. Only `success` requires an artifact,
 * and an unreadable, unparseable or shape-mismatched artifact is
 * `upstream.artifact_missing` with the reason in the message (R50).
 *
 * `results` holds only artifacts actually read, in job order. Propagated findings
 * are the registry artifact's `findings` and the negative artifact's
 * `negative.findings` (R51); a non-zero artifact exit with nothing propagated
 * adds `upstream.job_failed` naming the stage.
 */
export async function readStageResults(
  inputsDir: string,
  jobStatuses: Map<string, string>,
): Promise<{ results: StageResult[]; findings: Finding[] }> {
  const results: StageResult[] = [];
  const findings: Finding[] = [];

  for (const expected of EXPECTED_JOBS) {
    const file = `${expected.job}/${ARTIFACT}`;
    const status = jobStatuses.get(expected.job);

    if (status !== "success") {
      findings.push(statusFinding(expected.job, file, status));
      continue;
    }

    const read = await readStageResult(path.join(inputsDir, expected.job, ARTIFACT), expected, file);
    if (!read.ok) {
      findings.push(read.finding);
      continue;
    }

    results.push(read.result);
    const propagated = propagatedFindings(read.result);
    findings.push(...propagated);
    if (read.result.exit_code !== 0 && propagated.length === 0) {
      // The job reported success but its own artifact says otherwise. Fail
      // closed rather than pick which of the two statuses to believe.
      findings.push({
        code: "upstream.job_failed",
        message: `stage ${expected.stage} exited with code ${read.result.exit_code}`,
        file,
      });
    }
  }

  return { results, findings };
}

function statusFinding(job: string, file: string, status: string | undefined): Finding {
  if (status === undefined) {
    return {
      code: "upstream.job_missing",
      message: `${job} has no --job-status entry; a missing job is never a pass`,
      file,
    };
  }
  switch (status) {
    case "cancelled":
      return { code: "upstream.job_cancelled", message: `${job} was cancelled`, file };
    case "skipped":
      return { code: "upstream.job_skipped", message: `${job} was skipped`, file };
    case "failure":
      return { code: "upstream.job_failed", message: `${job} failed`, file };
    default:
      return {
        code: "upstream.job_failed",
        message: `${job} finished with status "${status}", which is not success`,
        file,
      };
  }
}

type StageRead = { ok: true; result: StageResult } | { ok: false; finding: Finding };

async function readStageResult(
  absolute: string,
  expected: { stage: StageName; job: string },
  file: string,
): Promise<StageRead> {
  let text: string;
  try {
    text = await readText(absolute);
  } catch (cause) {
    return { ok: false, finding: artifactMissing(file, unreadableDetail(cause)) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return {
      ok: false,
      finding: artifactMissing(file, `artifact is not valid JSON: ${errorMessage(cause)}`),
    };
  }

  const problem = shapeProblem(parsed, expected);
  if (problem !== null) {
    return { ok: false, finding: artifactMissing(file, `artifact is not a stage result: ${problem}`) };
  }
  return { ok: true, result: parsed as StageResult };
}

function artifactMissing(file: string, detail: string): Finding {
  return { code: "upstream.artifact_missing", message: detail, file };
}

/** A read failure without leaking an absolute path into the report. */
function unreadableDetail(cause: unknown): string {
  if (isNotFound(cause)) return "artifact not found";
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  return code === undefined ? "artifact is unreadable" : `artifact is unreadable (${code})`;
}

function shapeProblem(value: unknown, expected: { stage: StageName; job: string }): string | null {
  if (!isRecord(value)) return "the document is not an object";
  if (value["job"] !== expected.job) {
    return `job is ${describe(value["job"])}, expected ${JSON.stringify(expected.job)}`;
  }
  if (value["stage"] !== expected.stage) {
    return `stage is ${describe(value["stage"])}, expected ${JSON.stringify(expected.stage)}`;
  }
  const exitCode = value["exit_code"];
  if (exitCode !== 0 && exitCode !== 1 && exitCode !== 2) {
    return `exit_code is ${describe(exitCode)}, expected 0, 1 or 2`;
  }
  if (!Array.isArray(value["findings"])) return "findings is not an array";
  for (const [index, finding] of value["findings"].entries()) {
    const problem = findingProblem(finding, `findings[${index}]`);
    if (problem !== null) return problem;
  }
  if (value["checks"] !== undefined) {
    if (!Array.isArray(value["checks"])) return "checks is not an array";
    for (const [index, check] of value["checks"].entries()) {
      const problem = checkProblem(check, `checks[${index}]`);
      if (problem !== null) return problem;
    }
  }
  if (value["negative"] !== undefined) {
    const problem = negativeProblem(value["negative"]);
    if (problem !== null) return problem;
  }
  return null;
}

function findingProblem(value: unknown, at: string): string | null {
  if (!isRecord(value)) return `${at} is not an object`;
  for (const key of ["code", "message", "file"] as const) {
    if (typeof value[key] !== "string") return `${at}.${key} is not a string`;
  }
  if (value["line"] !== undefined && typeof value["line"] !== "number") {
    return `${at}.line is not a number`;
  }
  for (const key of ["ruleId", "flowId", "checkId"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      return `${at}.${key} is not a string`;
    }
  }
  return null;
}

function checkProblem(value: unknown, at: string): string | null {
  if (!isRecord(value)) return `${at} is not an object`;
  if (typeof value["runtimeId"] !== "string") return `${at}.runtimeId is not a string`;
  const outcome = value["outcome"];
  if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) {
    return `${at}.outcome is not a valid outcome: ${describe(outcome)}`;
  }
  if (value["classification"] !== undefined) {
    const classification = value["classification"];
    if (typeof classification !== "string" || !CLASSIFICATIONS.has(classification)) {
      return `${at}.classification is not valid: ${describe(classification)}`;
    }
  }
  if (value["message"] !== undefined && typeof value["message"] !== "string") {
    return `${at}.message is not a string`;
  }
  return null;
}

function negativeProblem(value: unknown): string | null {
  if (!isRecord(value)) return "negative is not an object";
  if (typeof value["declared"] !== "number") return "negative.declared is not a number";
  if (typeof value["executed"] !== "boolean") return "negative.executed is not a boolean";
  if (!Array.isArray(value["findings"])) return "negative.findings is not an array";
  for (const [index, finding] of value["findings"].entries()) {
    const problem = findingProblem(finding, `negative.findings[${index}]`);
    if (problem !== null) return problem;
  }
  return null;
}

/**
 * R51 propagates exactly two finding lists: the registry artifact's `findings`
 * and the negative artifact's `negative.findings`. The checks artifact's own
 * findings are not propagated: its observations are the `checks` outcomes, and
 * a non-zero exit with nothing propagated is `upstream.job_failed` below.
 */
function propagatedFindings(result: StageResult): Finding[] {
  if (result.stage === "registry") return [...result.findings];
  if (result.stage === "negative") return [...(result.negative?.findings ?? [])];
  return [];
}

interface Options {
  inputs: string;
  jobStatuses: Map<string, string>;
  doctorResult: string | null;
  repo: string | null;
  runId: string | null;
  baseline: string | null;
  root: string;
  out: string;
  comment: string;
}

const DEFAULT_OUT = "invariant-report.json";
const DEFAULT_COMMENT = "invariant-comment.md";

export async function verdict(argv: string[], io: CliIo): Promise<ExitCode> {
  const parsed = parseArgs(argv, io);
  if (parsed.kind === "exit") return parsed.code;
  const options = parsed.options;

  // R54: the registry must be the source of truth before any artifact is read.
  // An invalid registry is a gate error with no report — the same rule `run` uses.
  const { config, findings: configFindings } = await loadConfig(options.root);
  const { registry, findings: registryFindings } = await loadRegistry(options.root);
  const invalid = [
    ...configFindings,
    ...registryFindings,
    ...validateRegistry(registry, { cwd: options.root, config }),
  ];
  if (invalid.length > 0) {
    io.stderr(findingsText(invalid));
    return EXIT.GATE_BROKEN;
  }

  const discovery = await createDiscoverySource(config).discover(options.root);
  const discoveryFindings = discovery.errors.map(discoveryFinding);

  const upstream = await readStageResults(path.resolve(io.cwd, options.inputs), options.jobStatuses);
  const doctor = await readDoctor(options, io.cwd);

  let baseline: GuaranteeClass | null;
  try {
    baseline = await readBaseline(options.baseline, io.cwd);
  } catch (cause) {
    // A baseline that cannot be read is not "no baseline": the regression check
    // was requested, so the verifier cannot run. No report is published.
    io.stderr(`invariant verdict: ${errorMessage(cause)}\n`);
    return EXIT.GATE_BROKEN;
  }

  const checksArtifact = upstream.results.find((result) => result.stage === "checks");
  const results = alignResults(discovery.checks, checksArtifact?.checks ?? []);
  // PEND-1: nothing executes sabotage in this delivery, so no check has an outcome.
  const verdicts = computeVerdicts({
    registry,
    discovered: discovery.checks,
    results,
    outcomes: new Map(),
  });

  const negativeArtifact = upstream.results.find((result) => result.stage === "negative");
  const negativeControl: NegativeControlMode =
    negativeArtifact?.negative?.executed === true ? "executed" : "declared-only";

  const mismatch = doctor.finding === null ? [] : [{ code: doctor.finding.code, message: doctor.finding.message }];
  const classResult = computeClass({
    observationAvailable: doctor.ran && doctor.observation === "available",
    protectionFindings: [...doctor.findings, ...mismatch],
    credentialBoundary: config.credentialBoundary !== "none",
  });

  const doctorSummary: DoctorSummary = {
    ran: doctor.ran,
    class: classResult.class,
    reasons: [...classResult.reasons],
    findings: doctor.findings.map((finding) => ({ code: finding.code, message: finding.message })),
    observation: doctor.observation,
  };

  // Gate findings make the gate untrustworthy (exit 2). A doctor mismatch lowers
  // the class and stays visible in the report, but it is not a gate failure: a
  // run whose observation is unusable still has a product verdict (R52).
  const gateFindings = [
    ...upstream.findings,
    ...discoveryFindings,
    ...(baseline === null ? [] : regressionFindings(baseline, classResult.class, options.baseline ?? "")),
  ];
  const integrity = [...gateFindings, ...(doctor.finding === null ? [] : [doctor.finding])];

  const exitCode =
    gateFindings.length > 0 ? EXIT.GATE_BROKEN : rollUpGreen(verdicts) ? EXIT.GREEN : EXIT.PRODUCT_BROKEN;

  printGateFindings(io, gateFindings);

  const report = buildReport({
    root: options.root,
    toolVersion: TOOL_VERSION,
    // Task 12 derives mode/base/head from the CI event; until then this is an
    // explicit push-shaped input, never a guess made by this command.
    inputs: { mode: "push", base: null, head: null, repo: options.repo, runId: options.runId },
    registry,
    verdicts,
    integrity,
    guarantee: {
      class: classResult.class,
      classReasons: classResult.reasons,
      binding: classResult.binding,
      negativeControl,
      doctor: doctorSummary,
    },
    // Task 12 fills these in from the protected-path diff. This command performs
    // no diff and must not claim it checked immutability.
    immutability: { protectedPathsChanged: [], flagged: false },
    exitCode,
  });

  writeOut(options.out, stringifyJson(report), io);
  writeOut(options.comment, renderComment(report), io);
  io.stdout(`${classResult.class} ${exitReason(exitCode)}\n`);
  return exitCode;
}

/** Gate findings belong on stderr too: CI logs must say why the gate is red. */
function printGateFindings(io: CliIo, findings: Finding[]): void {
  if (findings.length > 0) io.stderr(findingsText(findings));
}

/**
 * R54: consume one artifact result per discovered check by `runtimeId`; a check
 * with no match gets an explicit `not-run`, and an artifact result that matches
 * nothing is ignored (it cannot be attributed to a check). The returned array is
 * index-aligned with `discovered`, so `computeVerdicts` never falls back to
 * positional pairing of a permuted artifact.
 */
function alignResults(discovered: DiscoveredCheck[], artifact: CheckResult[]): CheckResult[] {
  const consumed = new Set<number>();
  return discovered.map((check) => {
    const index = artifact.findIndex(
      (result, candidate) => !consumed.has(candidate) && result.runtimeId === check.runtimeId,
    );
    const matched = index === -1 ? undefined : artifact[index];
    if (matched === undefined) return { runtimeId: check.runtimeId, outcome: "not-run" };
    consumed.add(index);
    return matched;
  });
}

function rollUpGreen(verdicts: ReturnType<typeof computeVerdicts>): boolean {
  return (
    verdicts.checks.every((check) => check.verdict === "pass") &&
    verdicts.rules.every((rule) => rule.status !== "enforced" || rule.verdict === "pass") &&
    verdicts.flows.every((flow) => flow.verdict === "pass")
  );
}

function discoveryFinding(error: DiscoveryError): Finding {
  return {
    code: "integrity.discovery_error",
    message: error.message,
    file: error.file,
    ...(error.line === undefined ? {} : { line: error.line }),
  };
}

interface DoctorRead {
  ran: boolean;
  observation: "available" | "unavailable";
  findings: ClassFinding[];
  /** `doctor.result_mismatch` when the envelope or the file is unusable. */
  finding: Finding | null;
}

/**
 * R52: an envelope that disagrees with `--repo`/`--run-id` (or lacks the field)
 * makes the observation unusable — `ran: false`, `observation: unavailable` —
 * while the doctor's own findings still lower the class. The mismatch itself is
 * reported as `doctor.result_mismatch`; there is deliberately no second code for
 * an unreadable or malformed result, because it is equally unverifiable.
 */
async function readDoctor(options: Options, cwd: string): Promise<DoctorRead> {
  if (options.doctorResult === null) {
    return { ran: false, observation: "unavailable", findings: [], finding: null };
  }

  const file = toPosix(options.doctorResult);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readText(path.resolve(cwd, options.doctorResult)));
  } catch (cause) {
    return unusableDoctor(file, isNotFound(cause) ? "doctor result not found" : `doctor result is unreadable or not valid JSON: ${errorMessage(cause)}`);
  }
  if (!isRecord(parsed)) {
    return unusableDoctor(file, "doctor result is not an object");
  }
  const doctor = doctorShape(parsed["doctor"]);
  if (doctor === null) {
    return unusableDoctor(file, "doctor result does not carry a valid {repo, run_id, doctor} envelope");
  }

  const problems = envelopeProblems(parsed, options);
  if (problems.length > 0) {
    return {
      ran: false,
      observation: "unavailable",
      findings: doctor.findings,
      finding: { code: "doctor.result_mismatch", message: problems.join("; "), file },
    };
  }

  return { ran: doctor.ran, observation: doctor.observation, findings: doctor.findings, finding: null };
}

function unusableDoctor(file: string, message: string): DoctorRead {
  return {
    ran: false,
    observation: "unavailable",
    findings: [],
    finding: { code: "doctor.result_mismatch", message, file },
  };
}

function envelopeProblems(envelope: Record<string, unknown>, options: Options): string[] {
  const problems: string[] = [];
  if (options.repo !== null) {
    const actual = envelope["repo"];
    if (typeof actual !== "string") {
      problems.push(`doctor result has no repo, expected ${JSON.stringify(options.repo)}`);
    } else if (actual !== options.repo) {
      problems.push(`doctor result repo is ${JSON.stringify(actual)}, expected ${JSON.stringify(options.repo)}`);
    }
  }
  if (options.runId !== null) {
    const actual = envelope["run_id"];
    if (typeof actual !== "string") {
      problems.push(`doctor result has no run_id, expected ${JSON.stringify(options.runId)}`);
    } else if (actual !== options.runId) {
      problems.push(`doctor result run_id is ${JSON.stringify(actual)}, expected ${JSON.stringify(options.runId)}`);
    }
  }
  return problems;
}

function doctorShape(value: unknown): DoctorSummary | null {
  if (!isRecord(value)) return null;
  if (typeof value["ran"] !== "boolean") return null;
  if (!isClass(value["class"])) return null;
  if (typeof value["observation"] !== "string") return null;
  if (value["observation"] !== "available" && value["observation"] !== "unavailable") return null;
  if (!Array.isArray(value["reasons"]) || !value["reasons"].every((reason) => typeof reason === "string")) {
    return null;
  }
  if (!Array.isArray(value["findings"])) return null;
  const findings: ClassFinding[] = [];
  for (const finding of value["findings"]) {
    if (!isRecord(finding) || typeof finding["code"] !== "string" || typeof finding["message"] !== "string") {
      return null;
    }
    findings.push({ code: finding["code"], message: finding["message"] });
  }
  return {
    ran: value["ran"],
    class: value["class"],
    reasons: [...value["reasons"]],
    findings,
    observation: value["observation"],
  };
}

/** R53: PEND-6 puts the regression decision here, never in the workflow. */
async function readBaseline(file: string | null, cwd: string): Promise<GuaranteeClass | null> {
  if (file === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readText(path.resolve(cwd, file)));
  } catch (cause) {
    throw new Error(`cannot read baseline ${toPosix(file)}: ${errorMessage(cause)}`);
  }
  if (!isRecord(parsed) || !isClass(parsed["recorded_class"])) {
    throw new Error(`baseline ${toPosix(file)} must carry recorded_class "G1", "G2" or "G3"`);
  }
  return parsed["recorded_class"];
}

const CLASS_RANK: Record<GuaranteeClass, number> = { G3: 0, G2: 1, G1: 2 };

function regressionFindings(
  recorded: GuaranteeClass,
  current: GuaranteeClass,
  file: string,
): Finding[] {
  if (CLASS_RANK[current] >= CLASS_RANK[recorded]) return [];
  return [
    {
      code: "baseline.regressed",
      message: `guarantee class regressed from ${recorded} to ${current}`,
      file: toPosix(file),
    },
  ];
}

function exitReason(code: ExitCode): string {
  if (code === EXIT.GREEN) return "green";
  return code === EXIT.PRODUCT_BROKEN ? "product broken" : "gate broken";
}

function parseArgs(
  argv: string[],
  io: CliIo,
): { kind: "ok"; options: Options } | { kind: "exit"; code: ExitCode } {
  let inputs: string | null = null;
  const jobStatuses = new Map<string, string>();
  let doctorResult: string | null = null;
  let repo: string | null = null;
  let runId: string | null = null;
  let baseline: string | null = null;
  let root = io.cwd;
  let out = DEFAULT_OUT;
  let comment = DEFAULT_COMMENT;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) break;
    switch (arg) {
      case "-h":
      case "--help":
        io.stdout(HELP);
        return { kind: "exit", code: EXIT.GREEN };
      case "--job-status": {
        const value = argv[index + 1];
        if (value === undefined) {
          io.stderr("invariant verdict: --job-status requires <job>=<result>\n");
          return { kind: "exit", code: EXIT.GATE_BROKEN };
        }
        index += 1;
        const equals = value.indexOf("=");
        if (equals <= 0 || equals === value.length - 1) {
          io.stderr(`invariant verdict: --job-status expects <job>=<result>, got ${value}\n`);
          return { kind: "exit", code: EXIT.GATE_BROKEN };
        }
        jobStatuses.set(value.slice(0, equals), value.slice(equals + 1));
        break;
      }
      case "--inputs":
      case "--doctor-result":
      case "--repo":
      case "--run-id":
      case "--baseline":
      case "--root":
      case "--out":
      case "--comment":
      case "--base":
      case "--head": {
        const value = argv[index + 1];
        if (value === undefined) {
          io.stderr(`invariant verdict: ${arg} requires a value\n`);
          return { kind: "exit", code: EXIT.GATE_BROKEN };
        }
        index += 1;
        if (arg === "--inputs") inputs = value;
        else if (arg === "--doctor-result") doctorResult = value;
        else if (arg === "--repo") repo = value;
        else if (arg === "--run-id") runId = value;
        else if (arg === "--baseline") baseline = value;
        else if (arg === "--root") root = path.resolve(io.cwd, value);
        else if (arg === "--out") out = value;
        else if (arg === "--comment") comment = value;
        // --base and --head are accepted and ignored in this task: Task 12 owns
        // event parsing and the immutability diff.
        break;
      }
      default:
        io.stderr(`invariant verdict: unknown argument ${arg}\n`);
        return { kind: "exit", code: EXIT.GATE_BROKEN };
    }
  }

  if (inputs === null) {
    io.stderr("invariant verdict: --inputs <dir> is required\n");
    return { kind: "exit", code: EXIT.GATE_BROKEN };
  }

  return { kind: "ok", options: { inputs, jobStatuses, doctorResult, repo, runId, baseline, root, out, comment } };
}

/** One finding per line, in the same shape `validate` prints. */
function findingsText(findings: Finding[]): string {
  return findings.map(formatFinding).join("");
}

function formatFinding(finding: Finding): string {
  const location = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
  return `${location} ${finding.code} ${finding.message}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isClass(value: unknown): value is GuaranteeClass {
  return value === "G1" || value === "G2" || value === "G3";
}

function describe(value: unknown): string {
  if (value === undefined) return "absent";
  if (typeof value === "string") return JSON.stringify(value);
  const rendered = JSON.stringify(value);
  return rendered ?? String(value);
}

function isNotFound(cause: unknown): boolean {
  return cause instanceof Error && (cause as NodeJS.ErrnoException).code === "ENOENT";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
