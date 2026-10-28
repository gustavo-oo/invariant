import { findAdapter } from "../adapter/registry.js";
import type { Config } from "../config/model.js";
import type { DiscoveredCheck, DiscoveryError, DiscoveryResult, DiscoverySource } from "../discovery/types.js";

/**
 * The discovery seam `verify`, `run`, `negative` and `verdict` consume.
 *
 * It resolves **every** configured adapter and merges their checks in config
 * order. An unknown id is a recoverable configuration error, not a crash: it is
 * returned as a `DiscoveryError` so the caller maps it to exit 2.
 */
export function createDiscoverySource(config: Config): DiscoverySource {
  const ids = config.adapters.length > 0 ? config.adapters : [config.adapter];

  return {
    id: ids.join("+"),
    async discover(root: string): Promise<DiscoveryResult> {
      const checks: DiscoveredCheck[] = [];
      const errors: DiscoveryError[] = [];

      for (const id of ids) {
        const adapter = findAdapter(id);
        if (adapter === undefined) {
          errors.push({
            file: ".invariant/config.yaml",
            message: `unknown adapter: ${id}`,
          });
          continue;
        }
        const found = await adapter.discover(root);
        checks.push(...found.checks);
        errors.push(...found.errors);
      }

      return { checks, errors };
    },
  };
}
