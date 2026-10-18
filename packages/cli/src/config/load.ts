/**
 * The configuration loader: reads `.invariant/config.yaml` when present and
 * overlays it on the documented defaults (`model.ts`). An absent file is not an
 * error (review focus 1); a present but invalid file yields `config.schema`
 * findings and still returns the defaults for the offending properties.
 */
import type { ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { LineCounter, parseDocument } from "yaml";
import { readText } from "../fsutil.js";
import type { Finding } from "../registry/model.js";
import { DEFAULT_CONFIG, type Config, type CredentialBoundary, type ScopeMode, type SkillDistribution } from "./model.js";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const SCHEMA_URL = new URL("../../schema/config.schema.json", import.meta.url);

/** Repo-relative location of the configuration file. */
const CONFIG_FILE = ".invariant/config.yaml";

/**
 * Load the configuration for the repo at `root`. Always returns a complete
 * `Config` (defaults filled in), never throws for an absent or invalid file.
 */
export async function loadConfig(root: string): Promise<{ config: Config; findings: Finding[] }> {
  let text: string;
  try {
    text = await readText(path.join(root, CONFIG_FILE));
  } catch (cause) {
    if (isNotFound(cause)) return { config: mergeConfig({}), findings: [] };
    throw cause;
  }

  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines });
  const error = doc.errors[0];
  if (error !== undefined) {
    return { config: mergeConfig({}), findings: [configFinding(error.message, error.linePos?.[0]?.line)] };
  }

  let data: unknown;
  try {
    data = doc.toJS();
  } catch (cause) {
    return { config: mergeConfig({}), findings: [configFinding(cause instanceof Error ? cause.message : String(cause))] };
  }

  const validate = await configValidator();
  const findings: Finding[] = [];
  if (!validate(data)) {
    for (const issue of validate.errors ?? []) {
      findings.push(configFinding(`${issue.instancePath === "" ? "/" : issue.instancePath} ${issue.message ?? "is invalid"}`));
    }
  }
  return { config: mergeConfig(data), findings };
}

/** Compile the config validator once per process. */
let validator: Promise<ValidateFunction> | undefined;

function configValidator(): Promise<ValidateFunction> {
  validator ??= (async () => {
    const schema = JSON.parse(await readFile(SCHEMA_URL, "utf8")) as Record<string, unknown>;
    return new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  })();
  return validator;
}

function configFinding(message: string, line?: number): Finding {
  return line === undefined ? { code: "config.schema", message, file: CONFIG_FILE } : { code: "config.schema", message, file: CONFIG_FILE, line };
}

/** Overlay a parsed document (possibly invalid) on the documented defaults. */
function mergeConfig(raw: unknown): Config {
  const value = asRecord(raw);
  const scope = asRecord(value["scope"]);
  const skill = asRecord(value["skill"]);
  const doctor = asRecord(value["doctor"]);
  const ruleChange = asRecord(value["ruleChange"]);
  return {
    adapter: stringOr(value["adapter"], DEFAULT_CONFIG.adapter),
    scope: { mode: enumOr<ScopeMode>(scope["mode"], ["advisory", "blocking"], DEFAULT_CONFIG.scope.mode) },
    skill: {
      distribution: enumOr<SkillDistribution>(
        skill["distribution"],
        ["manifest-only", "opencode", "both"],
        DEFAULT_CONFIG.skill.distribution,
      ),
    },
    doctor: {
      apiUrl: stringOr(doctor["apiUrl"], DEFAULT_CONFIG.doctor.apiUrl),
      tokenEnv: stringOr(doctor["tokenEnv"], DEFAULT_CONFIG.doctor.tokenEnv),
      expectedAppId: integerOr(doctor["expectedAppId"], DEFAULT_CONFIG.doctor.expectedAppId),
    },
    ruleChange: { label: stringOr(ruleChange["label"], DEFAULT_CONFIG.ruleChange.label) },
    credentialBoundary: enumOr<CredentialBoundary>(
      value["credentialBoundary"],
      ["declared", "none"],
      DEFAULT_CONFIG.credentialBoundary,
    ),
    protectedPaths: stringArrayOr(value["protectedPaths"], DEFAULT_CONFIG.protectedPaths),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function integerOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function enumOr<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function stringArrayOr(value: unknown, fallback: readonly string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : [...fallback];
}

function isNotFound(cause: unknown): boolean {
  return cause instanceof Error && (cause as NodeJS.ErrnoException).code === "ENOENT";
}
