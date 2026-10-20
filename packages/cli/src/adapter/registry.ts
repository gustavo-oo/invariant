import type { Adapter } from "./api.js";
import { vitestAdapter } from "./vitest/index.js";

/**
 * Every adapter this build ships. The registry is the only place that knows the
 * concrete list; `findAdapter` is the lookup the discovery seam and the run
 * pipeline share.
 */
const REGISTERED: readonly Adapter[] = [vitestAdapter];

/** All registered adapters, as a copy so callers cannot mutate the registry. */
export function adapters(): Adapter[] {
  return [...REGISTERED];
}

export function findAdapter(id: string): Adapter | undefined {
  return REGISTERED.find((adapter) => adapter.id === id);
}
