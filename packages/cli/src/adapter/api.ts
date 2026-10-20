import type { DiscoveredCheck, DiscoveryResult } from "../discovery/types.js";

/** How an adapter is asked to run the tests it discovered. */
export interface RunOpts {
  root: string;
  /** Extra environment variables for the test process. */
  env?: Record<string, string>;
}

/** The outcome of one discovered test, keyed by its `runtimeId`. */
export interface CheckResult {
  runtimeId: string;
  outcome: "pass" | "fail" | "not-run" | "flaky";
  /** Why a failed test failed, when the adapter can tell. */
  classification?: "assertion" | "harness" | "timeout";
  message?: string;
}

/**
 * A test-framework adapter: discovery turns source files into `DiscoveredCheck`s,
 * `run` executes them, and `readReports` reads results a test process left on
 * disk. Discovery is the only member any task before the run pipeline consumes;
 * the others are part of the fixed seam so later tasks never reshape it.
 */
export interface Adapter {
  id: string;
  discover(root: string): Promise<DiscoveryResult>;
  run(checks: DiscoveredCheck[], opts: RunOpts): Promise<CheckResult[]>;
  readReports(paths: string[], root: string): Promise<CheckResult[] | null>;
}
