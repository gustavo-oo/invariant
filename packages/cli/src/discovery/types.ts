/**
 * Discovery: how a project's own tests declare the registry check they
 * implement. A test file carries a contiguous comment block above the test
 * (`@check`, `@rule`, `@flow`, optionally `@negative-control`); the discovery
 * adapter (`discover.ts`, Task 5) turns those blocks into `DiscoveredCheck`s.
 *
 * These types are deliberately framework-neutral: every adapter, whatever its
 * test runner, produces the same shape.
 */

/**
 * One place in a flow a check participates in. `step` is absent when the tag
 * names the flow as a whole (`@flow checkout`) rather than one of its steps
 * (`@flow checkout/s2`).
 */
export interface FlowRef {
  flow: string;
  step?: string;
}

/** A test that declared it implements a registry check. */
export interface DiscoveredCheck {
  checkId: string;
  rules: string[];
  flows: FlowRef[];
  /** Repo-relative sabotage path declared by `@negative-control`. */
  negativeControl?: string;
  testName: string;
  /** Repo-relative path of the file the test was found in. */
  file: string;
  /** 1-based line of the test call. */
  line: number;
  frameworkId: string;
  runtimeId: string;
}

/**
 * A discoverable problem that does not abort discovery: an unreadable file, a
 * floating tag block, a test whose tags cannot be resolved. Integrity problems
 * across the whole result (duplicate check ids, missing checks) are Task 8's.
 */
export interface DiscoveryError {
  /** Repo-relative path of the file the problem was found in. */
  file: string;
  /** 1-based line, when the problem has a location. */
  line?: number;
  message: string;
}

/** Everything a discovery adapter found, including the problems it recovered from. */
export interface DiscoveryResult {
  checks: DiscoveredCheck[];
  errors: DiscoveryError[];
}

/**
 * The seam between `verify` and a framework-specific discovery adapter. The
 * Phase 2 negative control aliases this module (PEND-8), so it must stay a
 * pure interface with no behaviour of its own.
 */
export interface DiscoverySource {
  id: string;
  discover(root: string): Promise<DiscoveryResult>;
}
