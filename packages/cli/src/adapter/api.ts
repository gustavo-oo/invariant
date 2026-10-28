import type { DiscoveredCheck, DiscoveryResult } from "../discovery/types.js";
import type { SabotageOutcome } from "../verdict/types.js";

/** How an adapter is asked to run the tests it discovered. */
export interface RunOpts {
  root: string;
  /**
   * The complete environment for the test process. When present it replaces
   * `process.env`; it is never merged, so a sabotaged run cannot inherit a
   * token the caller meant to drop.
   */
  env?: Record<string, string>;
  /** Hard limit for the child process; adapters choose their own default. */
  timeoutMs?: number;
}

/**
 * One check's sabotaged run, prepared by the negative-control executor. The
 * executor has already read and validated the sabotage file; the adapter only
 * installs it in `workdir` and runs the check.
 */
export interface SabotageSpec {
  check: DiscoveredCheck;
  /** Repo-relative path of the sabotage file (diagnostics only). */
  sabotagePath: string;
  /** Repo-relative path of the module the sabotage replaces. */
  seamAlias: string;
  /** The sabotage file's text, already read by the executor. */
  sabotageText: string;
  /** Absolute root of the isolated copy the adapter may mutate. */
  workdir: string;
  /** Sanitized environment; never the caller's process environment. */
  env: Record<string, string>;
  timeoutMs?: number;
}

/** The outcome of one discovered test, keyed by its `runtimeId`. */
export interface CheckResult {
  runtimeId: string;
  /** The adapter that produced this result; used to disambiguate equal ids. */
  frameworkId?: string;
  outcome: "pass" | "fail" | "not-run" | "flaky";
  /** Why a failed test failed, when the adapter can tell. */
  classification?: "assertion" | "harness" | "timeout";
  message?: string;
}

/**
 * A test-framework adapter: discovery turns source files into `DiscoveredCheck`s,
 * `run` executes them, and `readReports` reads results a test process left on
 * disk. `applySabotage` and `classifyFailure` are the Phase 2 negative-control
 * contract: the adapter installs the declared seam replacement in an isolated
 * copy and reports whether the target check failed, and how.
 */
export interface Adapter {
  id: string;
  discover(root: string): Promise<DiscoveryResult>;
  run(checks: DiscoveredCheck[], opts: RunOpts): Promise<CheckResult[]>;
  readReports(paths: string[], root: string): Promise<CheckResult[] | null>;
  /**
   * Apply the declared seam replacement in `spec.workdir`, run the target
   * check, and report what happened. `not-applied` covers both a failed
   * installation and a no-op (the check stayed green); neither is proof.
   */
  applySabotage(spec: SabotageSpec): Promise<SabotageOutcome>;
  /** Classify a failed result; only `assertion` can become proof. */
  classifyFailure(result: CheckResult): "assertion" | "harness" | "timeout";
}
