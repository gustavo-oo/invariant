/**
 * `invariant doctor` — the precondition gate (spec §9.3, PEND-6).
 *
 * The command observes the forge (or records why it cannot), runs the offline
 * §9.3 checks, and publishes the class it can actually prove. It always prints
 * the human block; `--json`/`--out` additionally write the `DoctorResult`
 * envelope that `verify`/`verdict` consume (the default file is
 * `invariant-doctor.json`).
 *
 * Exit codes are for humans and `--strict`. In CI the regression decision belongs
 * to `invariant-verdict`, which compares the recorded baseline with the reported
 * class; the workflow does not interpret this exit code (PEND-6).
 */
import path from "node:path";
import { loadConfig } from "../config/load.js";
import type { Config } from "../config/model.js";
import { readBaseline, writeBaseline, type Baseline } from "../doctor/baseline.js";
import { runDoctorChecks, type DoctorFinding } from "../doctor/checks.js";
import { EXIT, type ExitCode } from "../exit.js";
import { readText } from "../fsutil.js";
import { classRank, computeClass, type GuaranteeClass } from "../guarantee/class.js";
import { CLASS_MECHANISM, MECHANISM_LABEL, classMeaning } from "../guarantee/reasons.js";
import { stringifyJson, writeOut, type CliIo } from "../output.js";
import { createForgeProbe, type DoctorObservation } from "../seams/forge-probe.js";

const DEFAULT_OUT = "invariant-doctor.json";

const HELP = `invariant doctor - report the guarantee class this environment supports

Usage:
  invariant doctor [--root <dir>] [--record] [--strict] [--check <name>]
                   [--repo <owner/name>] [--run-id <id>] [--json] [--out <file>]

Options:
      --root <dir>       Repository root (default: the current directory).
      --record           Write the observed class and protection attributes to
                         .invariant/protection-baseline.json.
      --strict           Exit 1 whenever the observed class is below G1
                         (the default exits 1 only below the recorded baseline).
      --check <name>     Accepted for compatibility; the full doctor check runs.
      --repo <owner/name> Repository for the DoctorResult envelope (default:
                         $GITHUB_REPOSITORY).
      --run-id <id>      Run id for the DoctorResult envelope (default:
                         $GITHUB_RUN_ID).
      --json             Write the DoctorResult artifact (default
                         invariant-doctor.json) in addition to the human block.
      --out <file>       Artifact path (implies --json for the file).
  -h, --help             Print this help.

Exit codes:
  0  The observed class is at or above the recorded baseline (or G1 under --strict).
  1  The observed class is below the recorded baseline (or below G1 under --strict).
`;

export interface DoctorResult {
  schema_version: 1;
  repo: string | null;
  run_id: string | null;
  class: GuaranteeClass;
  reasons: string[];
  findings: DoctorFinding[];
  observation: DoctorObservation;
}

interface Options {
  root: string;
  record: boolean;
  strict: boolean;
  json: boolean;
  out: string | null;
  repo: string | null;
  runId: string | null;
  check: string | null;
}

export async function doctor(argv: string[], io: CliIo): Promise<ExitCode> {
  const parsed = parseArgs(argv, io);
  if (parsed.kind === "exit") return parsed.code;
  const options = parsed.options;

  const { config } = await loadConfig(options.root);
  const observation = await createForgeProbe(config).observe(options.root);
  const baselineRead = await readBaseline(options.root);
  const workflowText = await readWorkflowText(options.root);

  const checked = runDoctorChecks({
    observation,
    config,
    baseline: baselineRead.baseline,
    root: options.root,
    workflowText,
    // The check itself unions the filesystem scan; passing the list keeps the
    // interface honest for callers that already know it.
    workflowFiles: [],
  });

  const findings = [...baselineRead.findings, ...checked.findings];
  let cls = checked.class;
  let reasons = [...checked.reasons];
  if (baselineRead.findings.some((finding) => finding.severity === "fail")) {
    // A malformed baseline is a fail finding too; recompute so a G1 observation
    // cannot hide it behind a synthetic G3 baseline.
    const recomputed = computeClass({
      observationAvailable: observation.available,
      protectionFindings: findings
        .filter((finding) => finding.severity === "fail")
        .map(({ code, message }) => ({ code, message })),
      credentialBoundary: config.credentialBoundary === "declared",
    });
    cls = recomputed.class;
    reasons = [...new Set([...recomputed.reasons, ...reasons])];
  }

  const result: DoctorResult = {
    schema_version: 1,
    repo: options.repo ?? nonEmpty(process.env["GITHUB_REPOSITORY"]),
    run_id: options.runId ?? nonEmpty(process.env["GITHUB_RUN_ID"]),
    class: cls,
    reasons,
    findings,
    observation,
  };

  if (options.record) {
    await writeBaseline(options.root, recordedBaseline(baselineRead.baseline, observation, cls));
  }
  if (options.json || options.out !== null) {
    writeOut(options.out ?? DEFAULT_OUT, stringifyJson(result), io);
  }
  io.stdout(humanBlock(result, findings));

  const recorded = baselineRead.baseline.recorded_class;
  const code = options.strict
    ? classRank(cls) < classRank("G1")
      ? EXIT.PRODUCT_BROKEN
      : EXIT.GREEN
    : classRank(cls) < classRank(recorded)
      ? EXIT.PRODUCT_BROKEN
      : EXIT.GREEN;
  return code;
}

function humanBlock(result: DoctorResult, findings: DoctorFinding[]): string {
  const observation = result.observation.available
    ? "available"
    : `unavailable (${result.observation.reason})`;
  const protection = result.observation.available
    ? MECHANISM_LABEL[result.observation.protection.mechanism]
    : "unknown";
  const lines = [
    `observation: ${observation}`,
    `protection: ${protection}`,
    `class: ${result.class} (${CLASS_MECHANISM[result.class]})`,
    ...findings.map((finding) => `${finding.severity} ${finding.code} — ${finding.message}`),
    `what this class means: ${classMeaning(result.class)}`,
  ];
  return lines.join("\n") + "\n";
}

function recordedBaseline(
  current: Baseline,
  observation: DoctorObservation,
  cls: GuaranteeClass,
): Baseline {
  if (!observation.available) return { ...current, recorded_class: cls };

  const required =
    observation.protection.requiredContexts.find(
      (context) => context.context === current.expected.required_context,
    ) ?? observation.protection.requiredContexts[0];
  return {
    schema_version: 1,
    recorded_class: cls,
    expected: {
      required_context: required?.context ?? current.expected.required_context,
      required_context_app_id:
        required?.appId ?? current.expected.required_context_app_id,
      protected_paths: [...current.expected.protected_paths],
      bypass_actors: observation.protection.bypassActors.map((actor) => ({ ...actor })),
    },
  };
}

async function readWorkflowText(root: string): Promise<string> {
  try {
    return await readText(path.join(root, ".github/workflows/invariant.yml"));
  } catch {
    return "";
  }
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

function parseArgs(
  argv: string[],
  io: CliIo,
): { kind: "ok"; options: Options } | { kind: "exit"; code: ExitCode } {
  let root = io.cwd;
  let record = false;
  let strict = false;
  let json = false;
  let out: string | null = null;
  let repo: string | null = null;
  let runId: string | null = null;
  let check: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) break;
    switch (arg) {
      case "-h":
      case "--help":
        io.stdout(HELP);
        return { kind: "exit", code: EXIT.GREEN };
      case "--record":
        record = true;
        break;
      case "--strict":
        strict = true;
        break;
      case "--json":
        json = true;
        break;
      case "--root":
      case "--out":
      case "--repo":
      case "--run-id":
      case "--check": {
        const value = argv[index + 1];
        if (value === undefined) {
          io.stderr(`invariant doctor: ${arg} requires a value\n`);
          return { kind: "exit", code: EXIT.GATE_BROKEN };
        }
        index += 1;
        if (arg === "--root") root = path.resolve(io.cwd, value);
        else if (arg === "--out") out = value;
        else if (arg === "--repo") repo = value;
        else if (arg === "--run-id") runId = value;
        else check = value;
        break;
      }
      default:
        io.stderr(`invariant doctor: unknown argument ${arg}\n`);
        return { kind: "exit", code: EXIT.GATE_BROKEN };
    }
  }

  return { kind: "ok", options: { root, record, strict, json, out, repo, runId, check } };
}
