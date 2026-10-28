/**
 * `invariant verdict` — spec §9.4: the single aggregate check branch protection
 * requires, and the only job allowed to turn upstream facts into a verdict.
 *
 * The job fails **closed**. A cancelled, skipped, never-started or artifact-less
 * upstream job is red, and absence never means success: every expected job needs
 * an explicit `--job-status` entry *and*, when that entry requires a result, a
 * readable artifact (`registry-result.json`, `checks-result.json`,
 * `negative-result.json`). Anything else is a gate finding (exit 2), never a
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
import { readDoctorEvidence } from "../doctor/evidence.js";
import { EXIT, type ExitCode } from "../exit.js";
import { readText, toPosix } from "../fsutil.js";
import { classRank, computeClass, type GuaranteeClass } from "../guarantee/class.js";
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
      --inputs <dir>          Directory holding one artifact per job:
                              invariant-registry/registry-result.json,
                              invariant-checks/checks-result.json and
                              invariant-negative/negative-result.json. Required.
      --job-status <job>=...  The result GitHub reports for an upstream job.
                              Repeat once per job; a repeated job is a gate
                              failure. A job with no entry is red.
      --doctor-result <file>  The doctor's flat DoctorResult. Its observation
                              decides whether the class can be G1, and its
                              top-level repo/run_id must match --repo/--run-id
                              or the observation is unverifiable. Requires both.
      --repo <owner/name>     Expected repository, checked against the doctor
                              result's top-level repo. Required with
                              --doctor-result.
      --run-id <id>           Expected run id, checked the same way and required
                              with --doctor-result.
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
  invariant-negative. Each is read from its own artifact under <inputs>/<job>/:
  registry-result.json ({findings}), checks-result.json ({checks}) and
  negative-result.json ({findings} or {declared, executed, findings}). A job with
  no --job-status entry, a cancelled or skipped job, any other non-success
  status, or a success job whose artifact is missing, unreadable, unparseable or
  the wrong shape is a gate failure. Absence is never success.
  The checks job is the one exception: run exits 1 when a check is not pass, so
  a failed checks job is believed only when its artifact explains the failure
  with at least one non-pass outcome (exit 1). An all-pass artifact under a
  failed job is an unexplained failure: upstream.job_failed and exit 2. A
  missing or malformed artifact is upstream.job_failed and
  upstream.artifact_missing.

Exit codes:
  0  Every upstream artifact is green and every check, enforced rule and flow passed.
  1  The upstream artifacts are complete, but a check, enforced rule or flow did not pass.
  2  An upstream job is missing/cancelled/skipped or failed without explaining the
     failure, an artifact is missing or malformed, discovery failed, the registry
     is invalid, or the class regressed against --baseline.
`;

/** The three worker jobs the CI contract fixes (R49), in aggregation order. */
const EXPECTED_JOBS: ReadonlyArray<{ stage: StageName; job: string }> = [
  { stage: "registry", job: "invariant-registry" },
  { stage: "checks", job: "invariant-checks" },
  { stage: "negative", job: "invariant-negative" },
];

const ARTIFACTS: Record<StageName, string> = {
  registry: "registry-result.json",
  checks: "checks-result.json",
  negative: "negative-result.json",
};

/** One worker stage, named by its job directory and its artifact file. */
export type StageName = "registry" | "checks" | "negative";

/**
 * One upstream job's artifact, normalized to the facts the roll-up needs.
 *
 * The artifacts are the three commands' own `--json --out` payloads (plan lines
 * 1189-1191), not a wrapper: `validate` writes `{ findings }`, `run` writes
 * `{ checks }`, and `negative` writes `{ findings }` (later
 * `{ declared, executed, findings }`). There is no `stage`, `job` or `exit_code`
 * field in any of them; the directory and the file name carry those facts.
 */
export interface StageResult {
  stage: StageName;
  job: string;
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
 * `skipped` or any other non-`success` value produces an `upstream.*` finding
 * and the artifact is **not** read — a non-success job is never additionally
 * required to have one.
 *
 * The checks job is the one exception, and it is not a relaxation: `run` exits 1
 * exactly when a check is not `pass`, so CI reports a red *product* as a failed
 * checks job. A failed checks job is believed only when its artifact **explains
 * the failure** with at least one outcome other than `pass`; then the artifact is
 * the observation and the roll-up decides (exit 1). An all-`pass` artifact leaves
 * the job failure unexplained — a crashed worker or a later failing step — and
 * is not used: it yields `upstream.job_failed` (exit 2). A missing or malformed
 * artifact yields `upstream.job_failed` **and** `upstream.artifact_missing`.
 *
 * `results` holds only artifacts actually read and trusted, in job order.
 * Propagated findings are the registry artifact's and the negative artifact's
 * findings (R51).
 */
export async function readStageResults(
  inputsDir: string,
  jobStatuses: Map<string, string>,
): Promise<{ results: StageResult[]; findings: Finding[] }> {
  const results: StageResult[] = [];
  const findings: Finding[] = [];

  for (const expected of EXPECTED_JOBS) {
    const file = `${expected.job}/${ARTIFACTS[expected.stage]}`;
    const status = jobStatuses.get(expected.job);

    if (!expectsArtifact(expected.stage, status)) {
      findings.push(statusFinding(expected.job, file, status));
      continue;
    }

    const checksFailed = expected.stage === "checks" && status === "failure";

    const read = await readStageResult(
      path.join(inputsDir, expected.job, ARTIFACTS[expected.stage]),
      expected,
      file,
    );
    if (!read.ok) {
      // A failed checks job must explain itself through a red artifact. Without
      // one, the artifact is missing *and* the failure is unexplained.
      if (checksFailed) findings.push(unexplainedChecksFailure(expected.job, file));
      findings.push(read.finding);
      continue;
    }

    if (checksFailed && !explainsFailure(read.result)) {
      findings.push(unexplainedChecksFailure(expected.job, file));
      continue;
    }

    results.push(read.result);
    findings.push(...propagatedFindings(read.result));
  }

  return { results, findings };
}

/**
 * A checks job that failed is a red product, not a broken gate: `run` exits 1 on
 * any check that is not `pass`. The artifact must still exist.
 */
function expectsArtifact(stage: StageName, status: string | undefined): boolean {
  if (status === "success") return true;
  return stage === "checks" && status === "failure";
}

/**
 * A failed checks job is explained only by a red artifact: `run` exits 1 exactly
 * when a check is not `pass`. An all-green artifact (or none at all) leaves the
 * job failure unexplained — a worker that crashed after writing its result, or a
 * later step in the same job — and must never yield a green required check.
 */
function explainsFailure(result: StageResult): boolean {
  return (result.checks ?? []).some((check) => check.outcome !== "pass");
}

function unexplainedChecksFailure(job: string, file: string): Finding {
  return {
    code: "upstream.job_failed",
    message: `${job} failed with an unexplained result: the artifact does not report a non-pass check`,
    file,
  };
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

  const problem = payloadProblem(parsed, expected.stage);
  if (problem !== null) {
    return {
      ok: false,
      finding: artifactMissing(file, `artifact is not a ${ARTIFACTS[expected.stage]}: ${problem}`),
    };
  }
  return { ok: true, result: toStageResult(parsed as Record<string, unknown>, expected) };
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

/**
 * R50: each stage's payload is validated against the command that writes it. A
 * checks payload must carry `checks` (with known outcomes); a registry or
 * negative payload must carry `findings`. The negative command's richer payload
 * (`{declared, executed, findings}`) is accepted, but its two extra fields must
 * agree on presence: a half-written declaration is not an observation.
 */
function payloadProblem(value: unknown, stage: StageName): string | null {
  if (!isRecord(value)) return "the document is not an object";
  if (stage === "checks") {
    if (!Array.isArray(value["checks"])) return "checks is not an array";
    for (const [index, check] of value["checks"].entries()) {
      const problem = checkProblem(check, `checks[${index}]`);
      if (problem !== null) return problem;
    }
    return null;
  }

  if (!Array.isArray(value["findings"])) return "findings is not an array";
  for (const [index, finding] of value["findings"].entries()) {
    const problem = findingProblem(finding, `findings[${index}]`);
    if (problem !== null) return problem;
  }

  if (stage === "negative") {
    const declared = value["declared"];
    const executed = value["executed"];
    if (declared === undefined && executed === undefined) return null;
    if (typeof declared !== "number") return "negative.declared is not a number";
    if (typeof executed !== "boolean") return "negative.executed is not a boolean";
  }
  return null;
}

/** Map a validated payload onto the facts the roll-up consumes. */
function toStageResult(
  value: Record<string, unknown>,
  expected: { stage: StageName; job: string },
): StageResult {
  if (expected.stage === "checks") {
    // The checks artifact's own `findings` are not propagated: its observations
    // are the `checks` outcomes (R51).
    return {
      stage: expected.stage,
      job: expected.job,
      findings: [],
      checks: value["checks"] as CheckResult[],
    };
  }

  const findings = value["findings"] as Finding[];
  if (expected.stage === "negative" && value["declared"] !== undefined) {
    return {
      stage: expected.stage,
      job: expected.job,
      findings,
      negative: {
        declared: value["declared"] as number,
        executed: value["executed"] as boolean,
        findings: [...findings],
      },
    };
  }
  return { stage: expected.stage, job: expected.job, findings };
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

/**
 * R51 propagates the registry artifact's `findings` and the negative artifact's
 * findings. The checks artifact's observations are the `checks` outcomes, so its
 * payload has nothing to propagate.
 */
function propagatedFindings(result: StageResult): Finding[] {
  if (result.stage === "registry") return [...result.findings];
  if (result.stage === "negative") return [...(result.negative?.findings ?? result.findings)];
  return [];
}

interface Options {
  inputs: string;
  jobStatuses: Map<string, string>;
  /** Jobs whose `--job-status` was given more than once; ambiguous, never read as a pass. */
  duplicateStatuses: string[];
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
  const doctor = await readDoctorEvidence({
    doctorResult: options.doctorResult,
    repo: options.repo,
    runId: options.runId,
    cwd: io.cwd,
  });

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
  // A discovery failure is a gate problem, never a verdict about the product. A
  // roll-up over `discovered: []` would make every rule `rule_no_check`, which
  // reads as "the product broke" in the report and in the PR comment.
  // PEND-1: nothing executes sabotage in this delivery, so no check has an outcome.
  const verdicts: ReturnType<typeof computeVerdicts> =
    discoveryFindings.length > 0
      ? { checks: [], rules: [], flows: [] }
      : computeVerdicts({
          registry,
          discovered: discovery.checks,
          results,
          outcomes: new Map(),
        });

  const negativeArtifact = upstream.results.find((result) => result.stage === "negative");
  const negativeControl: NegativeControlMode =
    negativeArtifact?.negative?.executed === true ? "executed" : "declared-only";

  const classResult = computeClass({
    observationAvailable: doctor.ran && doctor.observation === "available",
    // R52: `readDoctorEvidence` already reduced the artifact to its `severity: "fail"`
    // findings. `info` findings describe the observation, they do not lower it.
    protectionFindings: doctor.findings,
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
    ...options.duplicateStatuses.map(duplicateStatusFinding),
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

/**
 * A repeated `--job-status` for one job is ambiguous, not "the last one wins":
 * `cancelled` followed by `success` would otherwise turn a cancelled job green.
 * The first entry is kept (so the report still shows the earliest claim) and the
 * duplicate itself is a gate failure.
 */
function duplicateStatusFinding(job: string): Finding {
  return {
    code: "upstream.job_status_duplicate",
    message: `--job-status was given more than once for ${job}; the job's result is ambiguous`,
    file: "--job-status",
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

function regressionFindings(
  recorded: GuaranteeClass,
  current: GuaranteeClass,
  file: string,
): Finding[] {
  if (classRank(current) >= classRank(recorded)) return [];
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
  const duplicateStatuses: string[] = [];
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
        const job = value.slice(0, equals);
        if (jobStatuses.has(job)) {
          duplicateStatuses.push(job);
        } else {
          jobStatuses.set(job, value.slice(equals + 1));
        }
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

  return { kind: "ok", options: { inputs, jobStatuses, duplicateStatuses, doctorResult, repo, runId, baseline, root, out, comment } };
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
