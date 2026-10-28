/**
 * `invariant verify` — spec §8: the eight stages in one process.
 *
 * Stage order is the spec's and is load-bearing:
 *
 * 1. config + registry load + §5 validation
 * 2. discovery (its errors, with stage 3's, are `integrity.*` gate findings)
 * 3. integrity reconciliation
 * 4. immutability (only with `--base`, exactly as `validate`)
 * 5. execution, or a report read first (Task 6's read-before-run contract)
 * 6. negative control — declaration only in this delivery (PEND-1)
 * 7. roll-up
 * 8. report + comment
 *
 * Exit precedence is `2 > 1 > 0`. Stages 1–3 breaking the gate stop the world:
 * the report is published with **no** rule verdicts (an invalid registry must
 * never produce `rule_no_check` product verdicts), and the comment's
 * `### Gate failures` section says why. A stage-4 product finding keeps exit 1;
 * a stage-4 finding that the check could not run is exit 2.
 *
 * Two facts are true by construction rather than by omission:
 *
 * - Every declared check is passed to `computeVerdicts` as `not-executed`, which
 *   is what makes `negative_control: "declared-only"` and
 *   `sabotage_verified: false` honest in a delivery that executes no sabotage.
 * - The class comes from `computeClass` over the doctor's **fail**-severity
 *   findings; without an attributable observation it can never be G1.
 */
import { tmpdir } from "node:os";
import path from "node:path";
import type { Adapter, CheckResult } from "../adapter/api.js";
import { alignReportResults } from "../adapter/align.js";
import { executeAdapters } from "../adapter/execute.js";
import { readEvent, type CiContext } from "../ci/event.js";
import { prepareVerify, type VerifyContext, type VerifyInput } from "../context.js";
import { readDoctorEvidence } from "../doctor/evidence.js";
import { EXIT, type ExitCode } from "../exit.js";
import { readText, toPosix } from "../fsutil.js";
import { classRank, computeClass, type GuaranteeClass } from "../guarantee/class.js";
import { immutabilityFinding, PROTECTED_PATH_CHANGED } from "../immutability/diff.js";
import { runNegativeControl } from "../negative/execute.js";
import { stringifyJson, writeOut, type CliIo } from "../output.js";
import { reconcile } from "../registry/integrity.js";
import type { Finding, Registry } from "../registry/model.js";
import { validateRegistry } from "../registry/validate.js";
import { renderComment } from "../report/comment.js";
import type { DoctorSummary, NegativeControlMode, Report, ReportInputs } from "../report/shape.js";
import { buildReport } from "../report/write.js";
import { computeVerdicts } from "../verdict/compute.js";
import type { CheckVerdict, FlowVerdict, RuleVerdict, SabotageOutcome } from "../verdict/types.js";
import { TOOL_VERSION } from "../version.js";

const HELP = `invariant verify - run every stage against this working tree

Usage:
  invariant verify [--root <dir>] [--adapter <id>] [--base <ref>] [--head <sha>]
                   [--event <path>] [--reports <file>]... [--doctor-result <file>]
                   [--repo <owner/name>] [--run-id <id>] [--baseline <file>]
                   [--out <file>] [--comment <file>] [--json]

Options:
      --root <dir>            Repository root (default: the current directory).
      --adapter <id>          Override the configured test-framework adapter.
      --base <ref>            Compare <ref>...HEAD and fail (exit 1) when a
                              protected path changed in a pull request without
                              the rule-change label. Without it no diff runs and
                              no immutability claim is made.
      --head <sha>            The head to diff against; defaults to the event's
                              head sha, then HEAD.
      --event <path>          GitHub event JSON (default: $GITHUB_EVENT_PATH).
                              It supplies the report's mode, base and head; an
                              event that is supplied and unreadable is a gate
                              failure, never a silent local audit.
      --reports <file>        Read results from a report instead of executing.
                              Repeatable; the first readable report wins.
                              Relative paths resolve against --root. A report
                              that cannot be read (missing or invalid JSON)
                              falls back to running the suite, never to "no
                              checks ran".
      --doctor-result <file>  The doctor's flat DoctorResult. Its observation
                              decides whether the class can be G1, and its
                              top-level repo/run_id must match --repo/--run-id
                              or the observation is unverifiable. A relative path
                              resolves against the CLI's cwd, like verdict.
      --repo <owner/name>     Expected repository for --doctor-result. The report
                              falls back to $GITHUB_REPOSITORY when the flag is
                              absent, but doctor attribution never reads ambient
                              environment, so the flag is always required for it.
      --run-id <id>           Expected run id for --doctor-result. The report
                              falls back to $GITHUB_RUN_ID when the flag is
                              absent; doctor attribution requires the flag.
      --baseline <file>       A recorded {"recorded_class": "G1"|"G2"|"G3"}.
                              A lower class than the baseline is a gate failure.
                              A relative path resolves against the CLI's cwd.
      --out <file>            Report path (default: invariant-report.json).
      --comment <file>        PR comment path (default: invariant-comment.md).
      --json                  Print the report instead of the summary line.
  -h, --help                  Print this help.

Stages:
  1 configuration + registry load + §5 validation   2 discovery
  3 integrity   4 immutability   5 execution or --reports   6 negative control
  7 roll-up   8 report + comment

Exit codes:
  0  Every enforced rule and every flow is green.
  1  An enforced rule or a flow is not green, or a protected path changed
     outside the flagged path.
  2  The registry or config is invalid, discovery or integrity failed, the
     event or diff could not be read, the adapter could not run, or the class
     regressed against --baseline.
`;

const DEFAULT_OUT = "invariant-report.json";
const DEFAULT_COMMENT = "invariant-comment.md";

export interface VerifyRunInput extends VerifyInput {
  doctorResult?: string;
  repo?: string;
  runId?: string;
  /** R62: the same `{ recorded_class }` regression gate `verdict` applies. */
  baseline?: string;
  out?: string;
  comment?: string;
}

export interface VerifyRun {
  report: Report;
  comment: string;
  code: ExitCode;
}

interface Verdicts {
  checks: CheckVerdict[];
  rules: RuleVerdict[];
  flows: FlowVerdict[];
}

export async function runVerify(input: VerifyRunInput): Promise<VerifyRun> {
  const prepared = await prepareVerify(input);
  const context = prepared.context;
  const root = context.root;
  const { config, registry, discovery } = context;
  // Stage 6 upgrades this to `executed` only after every declared sabotage ran.
  let negativeControl: NegativeControlMode = "declared-only";

  // The report records the event even when a later stage fails, and the
  // immutability check needs the same context; read it once, up front.
  const event = await readEvent(input.event === undefined ? undefined : path.resolve(root, input.event));

  // Stage 1: configuration and registry. The class is independent of the
  // registry, and the report needs a guarantee block on every exit path.
  const stage1 = [
    ...prepared.configFindings,
    ...prepared.registryFindings,
    ...validateRegistry(registry, { cwd: root, config }),
  ];
  // Stages 2–3: `reconcile` folds discovery errors in as
  // `integrity.discovery_error`, so one call covers both and no problem is
  // reported twice.
  const broken = stage1.length > 0 ? stage1 : reconcile(registry, discovery);

  // Attribution uses the flags only: ambient GITHUB_* may fill the report's
  // inputs (ruling 10), but nothing that can raise the class is read from the
  // environment.
  const doctor = await readDoctorEvidence({
    doctorResult: input.doctorResult === undefined ? null : repoRelative(root, input.doctorResult),
    repo: input.repo ?? null,
    runId: input.runId ?? null,
    cwd: root,
  });
  const classResult = computeClass({
    observationAvailable: doctor.ran && doctor.observation === "available",
    protectionFindings: doctor.findings,
    credentialBoundary: config.credentialBoundary === "declared",
  });
  const doctorSummary: DoctorSummary = {
    ran: doctor.ran,
    class: classResult.class,
    reasons: [...classResult.reasons],
    findings: doctor.findings.map((finding) => ({ code: finding.code, message: finding.message })),
    observation: doctor.observation,
  };
  const doctorFinding = doctor.finding === null ? [] : [doctor.finding];

  const inputs = reportInputs(input, event);
  const publish = (result: {
    verdicts: Verdicts;
    integrity: Finding[];
    protectedPathsChanged?: string[];
    flagged?: boolean;
    exitCode: ExitCode;
  }): VerifyRun => {
    const report = buildReport({
      root,
      toolVersion: TOOL_VERSION,
      inputs,
      registry,
      verdicts: result.verdicts,
      integrity: result.integrity,
      guarantee: {
        class: classResult.class,
        classReasons: classResult.reasons,
        binding: classResult.binding,
        negativeControl,
        doctor: doctorSummary,
      },
      immutability: {
        protectedPathsChanged: result.protectedPathsChanged ?? [],
        flagged: result.flagged ?? false,
      },
      exitCode: result.exitCode,
    });
    const comment = renderComment(report);
    writeOut(path.resolve(root, input.out ?? DEFAULT_OUT), stringifyJson(report));
    writeOut(path.resolve(root, input.comment ?? DEFAULT_COMMENT), comment);
    return { report, comment, code: result.exitCode };
  };

  if (broken.length > 0) {
    // R63: stages 1–3 failing publish the findings and nothing else. A verdict
    // computed from an invalid registry, a failed discovery or an unreconciled
    // mapping would describe the tool's own breakage as the product's.
    return publish({
      verdicts: { checks: [], rules: [], flows: [] },
      integrity: [...broken, ...doctorFinding],
      exitCode: EXIT.GATE_BROKEN,
    });
  }

  // Baseline regression (R62) is a gate finding, exactly like `verdict`'s. A
  // baseline that cannot be read is not "no baseline": the check was requested.
  const gateFindings: Finding[] = [];
  if (input.baseline !== undefined) {
    const baseline = await readBaseline(input.baseline, root);
    if (baseline.finding !== null) {
      gateFindings.push(baseline.finding);
    } else if (baseline.recorded !== null && classRank(classResult.class) < classRank(baseline.recorded)) {
      gateFindings.push({
        code: "baseline.regressed",
        message: `guarantee class regressed from ${baseline.recorded} to ${classResult.class}`,
        file: repoRelative(root, input.baseline),
      });
    }
  }

  // Stage 4. An unreadable supplied event is a gate finding even without
  // `--base`: it also means the report cannot know which mode it ran in, and
  // R58 forbids pretending that is a local audit.
  const stage4: Finding[] = [];
  let protectedPathsChanged: string[] = [];
  let flagged = false;
  if (event.eventStatus === "unreadable") {
    stage4.push({
      code: "ci.event_unreadable",
      message: "cannot read the CI event as JSON; immutability was not checked",
      file: "(event)",
    });
  } else if (input.base !== undefined) {
    try {
      const diff = await context.changedFiles.changedFiles(root, input.base, input.head ?? event.head ?? "HEAD");
      const result = immutabilityFinding({
        changed: diff.files,
        config,
        context: event,
        protectedPaths: config.protectedPaths,
      });
      protectedPathsChanged = result.protectedPathsChanged;
      flagged = result.flagged;
      if (result.finding !== null) stage4.push(result.finding);
    } catch (cause) {
      stage4.push({
        code: "immutability.diff_unavailable",
        message: portable(errorMessage(cause), root),
        file: "(diff)",
      });
    }
  }

  const productFindings = stage4.filter((finding) => finding.code === PROTECTED_PATH_CHANGED);
  gateFindings.push(...stage4.filter((finding) => finding.code !== PROTECTED_PATH_CHANGED));

  // Stage 5. Reports are read before anything executes; only a missing or
  // unreadable report falls back to the adapter (Task 6, spec §6).
  const executed = await execute(prepared.adapters, context, input.reports ?? []);
  if (!Array.isArray(executed)) {
    gateFindings.push({
      code: "adapter.failed",
      message: portable(executed.error, root),
      file: "(adapter)",
    });
    return publish({
      verdicts: { checks: [], rules: [], flows: [] },
      integrity: [...gateFindings, ...productFindings, ...doctorFinding],
      protectedPathsChanged,
      flagged,
      exitCode: EXIT.GATE_BROKEN,
    });
  }

  // Stage 6. The negative control runs every enforced check in an isolated
  // copy. A stage that cannot execute is a gate failure; a non-proof outcome is
  // a product finding and the rule is blocked by the roll-up.
  const negative = await runNegativeControl({
    registry,
    root,
    adapters: prepared.adapters,
    discovered: discovery.checks,
  });
  if (negative.errors.length > 0) {
    return publish({
      verdicts: { checks: [], rules: [], flows: [] },
      integrity: [...gateFindings, ...productFindings, ...negative.errors, ...doctorFinding],
      protectedPathsChanged,
      flagged,
      exitCode: EXIT.GATE_BROKEN,
    });
  }
  negativeControl = "executed";

  // Stage 7. The outcomes are the ones the executor produced; a green enforced
  // check without proof becomes `blocked` in the roll-up, never a silent pass.
  const verdicts = computeVerdicts({
    registry,
    discovered: discovery.checks,
    results: executed,
    outcomes: negative.outcomes,
  });

  const green = enforcedGreen(verdicts);
  const exitCode =
    gateFindings.length > 0
      ? EXIT.GATE_BROKEN
      : productFindings.length > 0 || negative.findings.length > 0 || !green
        ? EXIT.PRODUCT_BROKEN
        : EXIT.GREEN;

  return publish({
    verdicts,
    integrity: [...gateFindings, ...productFindings, ...negative.findings, ...doctorFinding],
    protectedPathsChanged,
    flagged,
    exitCode,
  });
}

/** R65: the one-line human summary, counting enforced rules only. */
function summaryLine(report: Report): string {
  const enforced = report.rules.filter((rule) => rule.status === "enforced");
  const green = enforced.filter((rule) => rule.verdict === "pass").length;
  return `${green} rules green, ${enforced.length - green} not green, class ${report.guarantee.class}, negative control ${report.guarantee.negative_control}\n`;
}

/**
 * Stage 5. Reports are file-less, so they are matched to discovered checks by
 * `runtimeId` (first match wins); the runner's own results are already one per
 * check in input order. A check with no report entry is `not-run`, never green.
 */
async function execute(
  adapters: Adapter[],
  context: VerifyContext,
  reports: string[],
): Promise<CheckResult[] | { error: string }> {
  return await executeAdapters(adapters, context.discovery.checks, { root: context.root }, reports);
}

/** Stages 5–7: only an enforced rule or any flow can redden the product. */
function enforcedGreen(verdicts: Verdicts): boolean {
  return (
    verdicts.rules.every((rule) => rule.status !== "enforced" || rule.verdict === "pass") &&
    verdicts.flows.every((flow) => flow.verdict === "pass")
  );
}

interface BaselineRead {
  recorded: GuaranteeClass | null;
  /** `baseline.unreadable` when the file is missing, unreadable or malformed. */
  finding: Finding | null;
}

/**
 * R62: a small, local baseline reader (Task 15 moves the shared one to
 * `baseline.ts`). A requested baseline that cannot be read is a gate finding,
 * never "no baseline".
 */
async function readBaseline(file: string, root: string): Promise<BaselineRead> {
  const shown = repoRelative(root, file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readText(path.resolve(root, file)));
  } catch (cause) {
    return {
      recorded: null,
      finding: {
        code: "baseline.unreadable",
        message: `cannot read baseline ${shown}: ${portable(errorMessage(cause), root)}`,
        file: shown,
      },
    };
  }
  if (!isRecord(parsed) || !isClass(parsed["recorded_class"])) {
    return {
      recorded: null,
      finding: { code: "baseline.unreadable", message: `baseline ${shown} must carry recorded_class "G1", "G2" or "G3"`, file: shown },
    };
  }
  return { recorded: parsed["recorded_class"], finding: null };
}

/** Ruling 10: the report's five inputs come from flags, the event, then the run env. */
function reportInputs(input: VerifyRunInput, event: CiContext): ReportInputs {
  return {
    mode: event.mode,
    base: input.base ?? event.base,
    head: input.head ?? event.head,
    repo: input.repo ?? nonEmpty(process.env["GITHUB_REPOSITORY"]),
    runId: input.runId ?? nonEmpty(process.env["GITHUB_RUN_ID"]),
  };
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

/** A repo-relative path for a finding, so no report ever carries a host path. */
function repoRelative(root: string, file: string): string {
  const relative = path.relative(root, path.resolve(root, file));
  return relative === "" ? "." : toPosix(relative);
}

/**
 * Adapter diagnostics name the repo root and a temp directory. Both are
 * host-specific, so they are folded to stable tokens before the message reaches
 * the report, the comment or stderr — the detail survives, the host does not.
 */
function portable(message: string, root: string): string {
  const text = oneLine(message).split(root).join(".").split(tmpdir()).join("<tmp>");
  // Anything still absolute is host-specific: keep the basename, drop the host.
  return text.replace(/(^|[\s'"(])(\/[^\s'")]*)/g, (_match, lead: string, absolute: string) => {
    const base = path.posix.basename(absolute);
    return `${lead}…/${base}`;
  });
}

/** Findings print one per line; multi-line git or Vitest output is folded. */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isClass(value: unknown): value is GuaranteeClass {
  return value === "G1" || value === "G2" || value === "G3";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// --- command -----------------------------------------------------------------

interface Options {
  root: string;
  adapters: string[];
  base: string | null;
  head: string | null;
  event: string | null;
  reports: string[];
  doctorResult: string | null;
  repo: string | null;
  runId: string | null;
  baseline: string | null;
  out: string;
  comment: string;
  json: boolean;
}

export async function verify(argv: string[], io: CliIo): Promise<ExitCode> {
  const parsed = parseArgs(argv, io);
  if (parsed.kind === "exit") return parsed.code;
  const options = parsed.options;

  const run = await runVerify({
    root: options.root,
    ...(options.adapters.length === 0 ? {} : { adapterIds: options.adapters }),
    ...(options.base === null ? {} : { base: options.base }),
    ...(options.head === null ? {} : { head: options.head }),
    ...(options.event === null ? {} : { event: options.event }),
    ...(options.reports.length === 0 ? {} : { reports: options.reports }),
    // These are artifacts, like verdict's: the CLI resolves them against its
    // own cwd, not against a --root that may point at another checkout.
    ...(options.doctorResult === null ? {} : { doctorResult: path.resolve(io.cwd, options.doctorResult) }),
    ...(options.repo === null ? {} : { repo: options.repo }),
    ...(options.runId === null ? {} : { runId: options.runId }),
    ...(options.baseline === null ? {} : { baseline: path.resolve(io.cwd, options.baseline) }),
    out: path.resolve(io.cwd, options.out),
    comment: path.resolve(io.cwd, options.comment),
  });

  // A red gate must say why on stderr too; the comment carries the same list.
  if (run.code === EXIT.GATE_BROKEN) {
    io.stderr(run.report.integrity.map(formatFinding).join(""));
  }
  io.stdout(options.json ? stringifyJson(run.report) : summaryLine(run.report));
  return run.code;
}

function parseArgs(argv: string[], io: CliIo): { kind: "ok"; options: Options } | { kind: "exit"; code: ExitCode } {
  let root = io.cwd;
  const adapters: string[] = [];
  let base: string | null = null;
  let head: string | null = null;
  let event: string | null = null;
  const reports: string[] = [];
  let doctorResult: string | null = null;
  let repo: string | null = null;
  let runId: string | null = null;
  let baseline: string | null = null;
  let out = DEFAULT_OUT;
  let comment = DEFAULT_COMMENT;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) break;
    switch (arg) {
      case "-h":
      case "--help":
        io.stdout(HELP);
        return { kind: "exit", code: EXIT.GREEN };
      case "--json":
        json = true;
        break;
      case "--root":
      case "--adapter":
      case "--base":
      case "--head":
      case "--event":
      case "--reports":
      case "--doctor-result":
      case "--repo":
      case "--run-id":
      case "--baseline":
      case "--out":
      case "--comment": {
        const value = argv[index + 1];
        if (value === undefined) {
          io.stderr(`invariant verify: ${arg} requires a value\n`);
          return { kind: "exit", code: EXIT.GATE_BROKEN };
        }
        index += 1;
        if (arg === "--root") root = path.resolve(io.cwd, value);
        else if (arg === "--adapter") adapters.push(value);
        else if (arg === "--base") base = value === "" ? null : value;
        else if (arg === "--head") head = value;
        // An explicit event path is cwd-relative like every other CLI path;
        // `GITHUB_EVENT_PATH` (used when this is null) is already absolute.
        else if (arg === "--event") event = path.resolve(io.cwd, value);
        else if (arg === "--reports") reports.push(value);
        else if (arg === "--doctor-result") doctorResult = value;
        else if (arg === "--repo") repo = value;
        else if (arg === "--run-id") runId = value;
        else if (arg === "--baseline") baseline = value;
        else if (arg === "--out") out = value;
        else comment = value;
        break;
      }
      default:
        io.stderr(`invariant verify: unknown argument ${arg}\n`);
        return { kind: "exit", code: EXIT.GATE_BROKEN };
    }
  }

  return { kind: "ok", options: { root, adapters, base, head, event, reports, doctorResult, repo, runId, baseline, out, comment, json } };
}

/** One finding per line, in the same shape `validate` prints. */
function formatFinding(finding: Finding): string {
  const location = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
  return `${location} ${finding.code} ${finding.message}\n`;
}
