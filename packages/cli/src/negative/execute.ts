/**
 * The negative-control executor (spec §7, §8 stage 6).
 *
 * For every check declared by an `enforced` rule it:
 *
 * 1. maps the registry declaration to the one discovered test that implements
 *    it (`@check`), refusing a missing or ambiguous match;
 * 2. reads the sabotage through the `SabotageSource` seam;
 * 3. creates a fresh isolated sandbox;
 * 4. asks the adapter that owns the check's framework to install the seam
 *    replacement and run the check;
 * 5. records the outcome and turns every non-proof result into a product
 *    finding (exit 1) or a gate error (exit 2).
 *
 * `executed` is true only when the stage ran for every declared check with no
 * gate error. A `not-applied`/`harness`/`timeout` outcome is a product red, not
 * an execution failure: the stage ran and the rule is simply not proven.
 */
import type { Adapter } from "../adapter/api.js";
import type { DiscoveredCheck } from "../discovery/types.js";
import type { Finding, Registry } from "../registry/model.js";
import { createSabotageSource } from "../seams/sabotage-source.js";
import type { SabotageOutcome } from "../verdict/types.js";
import { createSandbox, sanitizedEnv } from "./sandbox.js";

export interface NegativeControlInput {
  registry: Registry;
  root: string;
  adapters: Adapter[];
  /** The discovered checks; the executor never guesses a file or runtime id. */
  discovered: DiscoveredCheck[];
  /** Base environment; defaults to the process environment before sanitizing. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface NegativeControlRun {
  /** One outcome per enforced check id, in registry order (Map preserves it). */
  outcomes: Map<string, SabotageOutcome>;
  /** Non-proof results: product red (exit 1). */
  findings: Finding[];
  /** The stage could not run: gate red (exit 2). */
  errors: Finding[];
  declared: number;
  executed: boolean;
}

export async function runNegativeControl(input: NegativeControlInput): Promise<NegativeControlRun> {
  const outcomes = new Map<string, SabotageOutcome>();
  const findings: Finding[] = [];
  const errors: Finding[] = [];

  const byId = new Map<string, DiscoveredCheck>();
  const ambiguous = new Set<string>();
  for (const check of input.discovered) {
    if (byId.has(check.checkId)) ambiguous.add(check.checkId);
    else byId.set(check.checkId, check);
  }

  const adapters = new Map(input.adapters.map((adapter) => [adapter.id, adapter]));
  const source = createSabotageSource(input.root);
  let declared = 0;

  for (const rule of input.registry.rules) {
    if (rule.status !== "enforced") continue;

    for (const declaration of rule.checks) {
      declared += 1;
      const checkId = declaration.id;
      const sabotage = declaration.negativeControl?.sabotage;
      const identity = {
        file: sabotage ?? "(sabotage)",
        ruleId: rule.id,
        checkId,
      };

      const check = byId.get(checkId);
      if (ambiguous.has(checkId)) {
        errors.push(error("negative.check_ambiguous", `check ${checkId} is discovered more than once`, identity));
        outcomes.set(checkId, { status: "not-executed" });
        continue;
      }
      if (check === undefined) {
        errors.push(error("negative.check_not_discovered", `check ${checkId} has no discovered test`, identity));
        outcomes.set(checkId, { status: "not-executed" });
        continue;
      }
      if (sabotage === undefined) {
        errors.push(error("negative.sabotage_missing", `check ${checkId} declares no sabotage`, identity));
        outcomes.set(checkId, { status: "not-executed" });
        continue;
      }

      const file = await source.read(sabotage);
      if (file === null) {
        errors.push(error("negative.sabotage_missing", `sabotage ${sabotage} does not exist`, identity));
        outcomes.set(checkId, { status: "not-executed" });
        continue;
      }
      if (file.seamAlias === null) {
        errors.push(
          error("negative.seam_alias_missing", `sabotage ${sabotage} has no single @seam-alias`, identity),
        );
        outcomes.set(checkId, { status: "not-executed" });
        continue;
      }

      const adapter = adapters.get(check.frameworkId);
      if (adapter === undefined) {
        errors.push(
          error(
            "negative.execution_failed",
            `check ${checkId} uses framework ${check.frameworkId}, which has no adapter`,
            identity,
          ),
        );
        outcomes.set(checkId, { status: "not-applied" });
        continue;
      }

      let sandbox;
      try {
        sandbox = await createSandbox(input.root, `negative-${checkId}`);
      } catch (cause) {
        errors.push(error("negative.sandbox_failed", messageOf(cause), identity));
        outcomes.set(checkId, { status: "not-applied" });
        continue;
      }

      try {
        const outcome = await adapter.applySabotage({
          check,
          sabotagePath: sabotage,
          seamAlias: file.seamAlias,
          sabotageText: file.text,
          workdir: sandbox.root,
          env: sanitizedEnv(input.env ?? process.env, sandbox.root),
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        });
        outcomes.set(checkId, outcome);

        if (outcome.status === "not-executed") {
          errors.push(
            error("negative.not_executed", `adapter did not execute the sabotage for ${checkId}`, identity),
          );
          continue;
        }
        const finding = outcomeFinding(checkId, outcome, identity);
        if (finding !== null) findings.push(finding);
      } catch (cause) {
        // The adapter could not run: no product verdict can be trusted.
        errors.push(error("negative.execution_failed", messageOf(cause), identity));
        outcomes.set(checkId, { status: "not-applied" });
      } finally {
        await sandbox.cleanup().catch(() => {});
      }
    }
  }

  return {
    outcomes,
    findings,
    errors,
    declared,
    executed: errors.length === 0 && outcomes.size === declared,
  };
}

function outcomeFinding(
  checkId: string,
  outcome: SabotageOutcome,
  identity: Pick<Finding, "file" | "ruleId" | "checkId">,
): Finding | null {
  if (outcome.status === "applied" && outcome.classification === "assertion") return null;

  if (outcome.status === "not-applied") {
    return error(
      "negative.sabotage_not_applied",
      `check ${checkId} stayed green under its sabotage; the seam was not exercised or the sabotage is a no-op`,
      identity,
    );
  }
  if (outcome.status === "applied" && outcome.classification === "harness") {
    return error(
      "negative.sabotage_harness",
      `check ${checkId} failed with a harness error under sabotage; that is not proof`,
      identity,
    );
  }
  if (outcome.status === "applied" && outcome.classification === "timeout") {
    return error(
      "negative.sabotage_timeout",
      `check ${checkId} timed out under sabotage; that is not proof`,
      identity,
    );
  }
  return error("negative.sabotage_not_applied", `check ${checkId} is not proven able to fail`, identity);
}

function error(
  code: string,
  message: string,
  identity: Pick<Finding, "file" | "ruleId" | "checkId">,
): Finding {
  return { code, message, ...identity };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
