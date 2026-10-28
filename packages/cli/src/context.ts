/**
 * The composition root for `invariant verify` (spec §8).
 *
 * Every collaborator is created **only** through its module in `src/seams/`:
 * discovery through `createDiscoverySource`, changed files through
 * `createChangedFilesProvider`, execution through `createCheckRunner` over the
 * adapter `findAdapter` resolves, and the forge observation through
 * `createForgeProbe`. That indirection is what makes the SELF rules
 * sabotage-able (spec §7): a check that assembled a runner or an adapter by hand
 * would keep using it after Phase 2 replaces the seam, and its sabotage would be
 * a no-op.
 *
 * `buildVerifyContext` is the documented entry point. `prepareVerify` is the
 * same single load path, additionally returning the loader findings and the
 * resolved adapter: `verify` must decide stages 1–2 from those findings before
 * anything executes, and it reads a report through the adapter before running
 * anything (Task 6's read-before-run contract). Loading twice instead would
 * mean two sources of truth for one registry.
 */
import path from "node:path";
import type { Adapter } from "./adapter/api.js";
import { findAdapter } from "./adapter/registry.js";
import { loadConfig } from "./config/load.js";
import type { Config } from "./config/model.js";
import type { DiscoveryResult } from "./discovery/types.js";
import type { Finding, Registry } from "./registry/model.js";
import { loadRegistry } from "./registry/load.js";
import type { ChangedFilesProvider } from "./seams/changed-files.js";
import { createChangedFilesProvider } from "./seams/changed-files.js";
import type { CheckRunner } from "./seams/check-runner.js";
import { createCheckRunner } from "./seams/check-runner.js";
import { createDiscoverySource } from "./seams/discovery-source.js";
import type { ForgeProbe } from "./seams/forge-probe.js";
import { createForgeProbe } from "./seams/forge-probe.js";

/**
 * The explicit inputs of a verification. The one piece of ambient state
 * `runVerify` adds is the run environment's `GITHUB_REPOSITORY`/`GITHUB_RUN_ID`
 * for the report's inputs (ruling 10), never anything that changes a verdict.
 */
export interface VerifyInput {
  root: string;
  adapterId?: string;
  base?: string;
  head?: string;
  event?: string;
  reports?: string[];
}

/** Everything the eight stages consume, each obtained from its seam. */
export interface VerifyContext {
  root: string;
  config: Config;
  registry: Registry;
  discovery: DiscoveryResult;
  changedFiles: ChangedFilesProvider;
  runner: CheckRunner;
  forgeProbe: ForgeProbe;
}

/**
 * The context plus what stages 1–2 need to explain themselves. The adapter is
 * resolved once here and exposed so the command can call `readReports` under the
 * read-before-run contract without looking it up again; the runner was built
 * from the same resolution.
 */
export interface PreparedVerify {
  context: VerifyContext;
  configFindings: Finding[];
  registryFindings: Finding[];
  adapter: Adapter | undefined;
}

/** Build the context `verify` runs against. */
export async function buildVerifyContext(input: VerifyInput): Promise<VerifyContext> {
  return (await prepareVerify(input)).context;
}

/** Load, resolve and compose once; `buildVerifyContext` is the public half. */
export async function prepareVerify(input: VerifyInput): Promise<PreparedVerify> {
  const root = path.resolve(input.root);
  const loaded = await loadConfig(root);
  const config: Config =
    input.adapterId === undefined ? loaded.config : { ...loaded.config, adapter: input.adapterId };
  const { registry, findings: registryFindings } = await loadRegistry(root);
  const adapter = findAdapter(config.adapter);

  return {
    context: {
      root,
      config,
      registry,
      discovery: await createDiscoverySource(config).discover(root),
      changedFiles: createChangedFilesProvider(),
      // An unknown adapter is already a discovery error (stage 2, exit 2), so
      // this placeholder is never reached; if it ever were, the runner fails
      // closed instead of executing nothing and reporting green.
      runner: createCheckRunner(adapter ?? unavailableAdapter(config.adapter)),
      forgeProbe: createForgeProbe(config),
    },
    configFindings: loaded.findings,
    registryFindings,
    adapter,
  };
}

/** A runner for a configuration stage 2 already rejected: it can only fail. */
function unavailableAdapter(id: string): Adapter {
  return {
    id,
    async discover() {
      return { checks: [], errors: [] };
    },
    async run() {
      throw new Error(`invariant: unknown adapter: ${id}`);
    },
    async readReports() {
      return null;
    },
    async applySabotage() {
      return { status: "not-applied" };
    },
    classifyFailure() {
      return "harness";
    },
  };
}
