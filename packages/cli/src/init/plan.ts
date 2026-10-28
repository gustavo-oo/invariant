/**
 * `invariant init` planning: read the target tree and the shipped assets,
 * compute every write, and return findings for anything that must not be
 * overwritten. This module never writes; `applyInit` (used by the command and
 * the tests) performs the plan.
 *
 * The walking skeleton is intentionally one capability, one critical flow, one
 * enforced rule, one seam and one declared sabotage. It is the acceptance test
 * of the whole pipeline; adopters delete it once real rules exist.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Baseline } from "../doctor/baseline.js";
import { renderBaseline } from "../doctor/baseline.js";
import { readText } from "../fsutil.js";
import { loadRegistry } from "../registry/load.js";
import type { Finding } from "../registry/model.js";
import { renderWorkflow } from "../workflow/render.js";

export interface InitInput {
  root: string;
  owner: string;
  adapter: string;
  cliSetup: string;
  invariantCmd: string;
  invariantVersion: string;
  baseline: Baseline;
}

export type InitWriteMode = "create" | "append-block" | "skip";

export interface InitWrite {
  path: string;
  content: string;
  mode: InitWriteMode;
}

export interface InitPlan {
  writes: InitWrite[];
  findings: Finding[];
}

const CODEOWNERS = ".github/CODEOWNERS";
const CODEOWNERS_START = "# >>> invariant >>>";

const SKELETON = [
  "rules/example.yaml",
  "rules/flows/example.yaml",
  "invariant-example/limiter.ts",
  "invariant-example/limiter.test.ts",
  "invariant-example/README.md",
  ".invariant/sabotages/example/limit-unbounded.ts",
] as const;

const ASSETS = new URL("../assets/", import.meta.url);

export async function planInit(input: InitInput): Promise<InitPlan> {
  const { baseline } = input;
  const findings: Finding[] = [];

  const skeleton = await Promise.all(
    SKELETON.map(async (file) => [
      file,
      replaceAll(await readText(asset("walking-skeleton", file)), "__OWNER__", input.owner),
    ] as const),
  );

  const config = replaceAll(
    replaceAll(
      replaceAll(
        await readText(asset("config.yaml")),
        "__ADAPTER__",
        input.adapter,
      ),
      "__APP_ID__",
      String(baseline.expected.required_context_app_id),
    ),
    "__PROTECTED_PATHS__",
    JSON.stringify(baseline.expected.protected_paths),
  );

  const rulesetTemplate = await readText(asset("ruleset.json"));
  const ruleset = JSON.parse(
    replaceAll(
      replaceAll(rulesetTemplate, "__REQUIRED_CONTEXT__", baseline.expected.required_context),
      "__APP_ID__",
      String(baseline.expected.required_context_app_id),
    ),
  ) as unknown;

  const workflow = renderWorkflow(await readText(asset("workflow.yml")), {
    cliSetup: input.cliSetup,
    invariantCmd: input.invariantCmd,
    invariantVersion: input.invariantVersion,
    protectedPaths: baseline.expected.protected_paths,
  });

  const codeowners = replaceAll(
    await readText(asset("codeowners-block.txt")),
    "__OWNER__",
    input.owner,
  );

  const writes: InitWrite[] = [];
  const codeownersExisting = await readOptional(input.root, CODEOWNERS);
  if (codeownersExisting !== null && codeownersExisting.includes(CODEOWNERS_START)) {
    writes.push({ path: CODEOWNERS, content: codeowners, mode: "skip" });
    findings.push({
      code: "init.codeowners_block_exists",
      message: "the invariant CODEOWNERS block is already present; left unchanged",
      file: CODEOWNERS,
    });
  } else {
    writes.push({
      path: CODEOWNERS,
      content: codeowners,
      mode: codeownersExisting === null ? "create" : "append-block",
    });
  }

  writes.push(
    { path: ".github/workflows/invariant.yml", content: workflow, mode: await modeFor(input.root, ".github/workflows/invariant.yml", findings) },
    { path: ".invariant/config.yaml", content: config, mode: await modeFor(input.root, ".invariant/config.yaml", findings) },
    { path: ".invariant/protection-baseline.json", content: renderBaseline(baseline), mode: await modeFor(input.root, ".invariant/protection-baseline.json", findings) },
    { path: ".invariant/protection.ruleset.json", content: JSON.stringify(ruleset, null, 2) + "\n", mode: await modeFor(input.root, ".invariant/protection.ruleset.json", findings) },
  );

  for (const [file, content] of skeleton) {
    if (file === "rules/example.yaml" && (await exampleRuleExists(input.root))) {
      writes.push({ path: file, content, mode: "skip" });
      findings.push({
        code: "init.example_rule_exists",
        message: "rule EXAMPLE-001 already exists; the walking-skeleton rule was not written",
        file,
      });
    } else {
      writes.push({ path: file, content, mode: await modeFor(input.root, file, findings) });
    }
  }

  return { writes, findings };
}

/** Perform a plan. A skipped write is a no-op; an append keeps the existing bytes. */
export async function applyInit(root: string, writes: InitWrite[]): Promise<void> {
  for (const write of writes) {
    if (write.mode === "skip") continue;
    const file = path.join(root, write.path);
    await mkdir(path.dirname(file), { recursive: true });
    if (write.mode === "append-block") {
      const current = await readOptional(root, write.path);
      const prefix = current === null || current === "" || current.endsWith("\n")
        ? current ?? ""
        : `${current}\n`;
      await writeFile(file, prefix + write.content, "utf8");
    } else {
      await writeFile(file, write.content, "utf8");
    }
  }
}

async function modeFor(root: string, file: string, findings: Finding[]): Promise<InitWriteMode> {
  if (!(await exists(root, file))) return "create";
  findings.push({
    code: "init.file_exists",
    message: "file already exists; left unchanged",
    file,
  });
  return "skip";
}

async function exampleRuleExists(root: string): Promise<boolean> {
  try {
    const { registry } = await loadRegistry(root);
    return registry.rules.some((rule) => rule.id === "EXAMPLE-001");
  } catch {
    return false;
  }
}

async function exists(root: string, file: string): Promise<boolean> {
  try {
    await stat(path.join(root, file));
    return true;
  } catch (cause) {
    if (isNotFound(cause)) return false;
    throw cause;
  }
}

async function readOptional(root: string, file: string): Promise<string | null> {
  try {
    return await readText(path.join(root, file));
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw cause;
  }
}

function asset(...parts: string[]): string {
  return fileURLToPath(new URL(parts.join("/"), ASSETS));
}

function replaceAll(text: string, needle: string, value: string): string {
  return text.replaceAll(needle, () => value);
}

function isNotFound(cause: unknown): boolean {
  return cause instanceof Error && (cause as NodeJS.ErrnoException).code === "ENOENT";
}
