import { findAdapter } from "../adapter/registry.js";
import type { Config } from "../config/model.js";
import type { DiscoveryResult, DiscoverySource } from "../discovery/types.js";

/**
 * The discovery seam `verify` consumes. Phase 2 aliases this module (PEND-8), so
 * it holds no discovery logic: it resolves the configured adapter and delegates.
 *
 * An unknown adapter is a recoverable configuration error, not a crash: it is
 * returned as a `DiscoveryError` so the caller maps it to exit 2 cleanly, with
 * no stack trace.
 */
export function createDiscoverySource(config: Config): DiscoverySource {
  return {
    id: config.adapter,
    async discover(root: string): Promise<DiscoveryResult> {
      const adapter = findAdapter(config.adapter);
      if (adapter === undefined) {
        return {
          checks: [],
          errors: [{ file: ".invariant/config.yaml", message: `unknown adapter: ${config.adapter}` }],
        };
      }
      return adapter.discover(root);
    },
  };
}
