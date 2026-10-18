/**
 * Process exit codes, from the design spec §8.
 *
 * - `0` (`GREEN`) — every enforced rule and flow is green.
 * - `1` (`PRODUCT_BROKEN`) — a rule or a flow is not green.
 * - `2` (`GATE_BROKEN`) — the registry is invalid, the adapter failed, integrity
 *   is broken, or the verifier could not run.
 */
export const EXIT = {
  GREEN: 0,
  PRODUCT_BROKEN: 1,
  GATE_BROKEN: 2,
} as const;

export type ExitCode = 0 | 1 | 2;
