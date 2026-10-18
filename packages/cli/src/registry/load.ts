/**
 * The registry loader: turns `rules/**` YAML into a `Registry` plus a list of
 * `Finding`s. It does I/O, YAML parsing, JSON Schema validation, file-naming
 * checks (PEND-9) and type construction — and nothing else. The spec §5
 * cross-cutting rules live in `validate.ts`.
 *
 * A document that violates the schema is still converted (best effort) so the
 * validator can report the semantic problem; the schema violation itself is a
 * `registry.schema` finding.
 */
import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";
import { listFiles, readText } from "../fsutil.js";
import type {
  CheckDecl,
  CheckLayer,
  Criticality,
  Finding,
  Flow,
  FlowCheckDecl,
  FlowStep,
  NegativeControl,
  Registry,
  Rule,
  RuleStatus,
  SourceRef,
} from "./model.js";

export type { Finding } from "./model.js";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const SCHEMA_URL = new URL("../../schema/registry.schema.json", import.meta.url);

type YamlDoc = ReturnType<typeof parseDocument>;

/**
 * Read every registry file under `root` and convert it into a `Registry`.
 * A missing `rules/` directory is not an error: it yields an empty registry and
 * no findings.
 */
export async function loadRegistry(root: string): Promise<{ registry: Registry; findings: Finding[] }> {
  const capabilityFiles = await listFiles(root, "rules/*.yaml");
  const flowFiles = await listFiles(root, "rules/flows/*.yaml");
  const validators = await registryValidators();

  const findings: Finding[] = [];
  const rules: Rule[] = [];
  const flows: Flow[] = [];

  for (const file of capabilityFiles) {
    const parsed = parseYaml(await readText(path.join(root, file)));
    if (!parsed.ok) {
      findings.push(parseFinding("registry.yaml_parse", file, parsed));
      continue;
    }
    if (!validators.capability(parsed.data)) {
      findings.push(...schemaFindings(validators.capability.errors ?? [], file, parsed.doc, parsed.lines, "rules"));
    }
    const node = childNode(parsed.doc, "rules");
    const rawRules = toArray(asRecord(parsed.data)["rules"]);
    rawRules.forEach((raw, index) => rules.push(toRule(raw, sourceOf(file, node, index, parsed.lines))));

    const expected = capabilityName(file);
    const capability = asRecord(parsed.data)["capability"];
    if (capability !== expected) {
      findings.push({
        code: "registry.file_capability_mismatch",
        message: `capability "${describe(capability)}" does not match file name "${expected}"`,
        file,
      });
    }
  }

  for (const file of flowFiles) {
    const parsed = parseYaml(await readText(path.join(root, file)));
    if (!parsed.ok) {
      findings.push(parseFinding("registry.yaml_parse", file, parsed));
      continue;
    }
    if (!validators.flow(parsed.data)) {
      findings.push(...schemaFindings(validators.flow.errors ?? [], file, parsed.doc, parsed.lines, "flows"));
    }
    const node = childNode(parsed.doc, "flows");
    const rawFlows = toArray(asRecord(parsed.data)["flows"]);
    rawFlows.forEach((raw, index) => flows.push(toFlow(raw, sourceOf(file, node, index, parsed.lines))));

    const expected = capabilityName(file);
    if (rawFlows.length !== 1 || asRecord(rawFlows[0])["id"] !== expected) {
      findings.push({
        code: "registry.flow_file_id_mismatch",
        message: `"${file}" must declare exactly one flow with id "${expected}"`,
        file,
      });
    }
  }

  const files = [...capabilityFiles, ...flowFiles].sort();
  return { registry: { rules, flows, files }, findings };
}

/** Compile the capability and flow validators once per process. */
let validators: Promise<{ capability: ValidateFunction; flow: ValidateFunction }> | undefined;

function registryValidators(): Promise<{ capability: ValidateFunction; flow: ValidateFunction }> {
  validators ??= buildValidators();
  return validators;
}

async function buildValidators(): Promise<{ capability: ValidateFunction; flow: ValidateFunction }> {
  const { $defs } = JSON.parse(await readFile(SCHEMA_URL, "utf8")) as { $defs?: Record<string, unknown> };
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return {
    capability: ajv.compile({ $schema: DRAFT_2020_12, $defs, $ref: "#/$defs/capabilityDocument" }),
    flow: ajv.compile({ $schema: DRAFT_2020_12, $defs, $ref: "#/$defs/flowDocument" }),
  };
}

type ParseResult =
  | { ok: true; doc: YamlDoc; data: unknown; lines: LineCounter }
  | { ok: false; message: string; line?: number };

function parseYaml(text: string): ParseResult {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines });
  const error = doc.errors[0];
  if (error !== undefined) {
    const line = error.linePos?.[0]?.line;
    return line === undefined ? { ok: false, message: error.message } : { ok: false, message: error.message, line };
  }
  try {
    return { ok: true, doc, data: doc.toJS(), lines };
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
}

function parseFinding(code: string, file: string, failure: { message: string; line?: number }): Finding {
  return failure.line === undefined
    ? { code, message: failure.message, file }
    : { code, message: failure.message, file, line: failure.line };
}

function schemaFindings(
  errors: readonly ErrorObject[],
  file: string,
  doc: YamlDoc,
  lines: LineCounter,
  key: "rules" | "flows",
): Finding[] {
  return errors.map((error) => {
    const message = `${error.instancePath === "" ? "/" : error.instancePath} ${error.message ?? "is invalid"}`;
    const line = lineForPath(doc, lines, key, error.instancePath);
    return line === undefined ? { code: "registry.schema", message, file } : { code: "registry.schema", message, file, line };
  });
}

/** The line of `/<key>/<index>/...` in `doc`, when the error points at one item. */
function lineForPath(doc: YamlDoc, lines: LineCounter, key: string, instancePath: string): number | undefined {
  const [, top, index] = instancePath.split("/");
  if (top !== key || index === undefined || !/^\d+$/.test(index)) return undefined;
  return nodeLine(childNode(doc, key), Number(index), lines);
}

/** The value node of a top-level mapping key, if the document root is a map. */
function childNode(doc: YamlDoc, key: string): unknown {
  const root = doc.contents;
  if (!isMap(root)) return undefined;
  for (const pair of root.items) {
    if (isScalar(pair.key) && pair.key.value === key) return pair.value;
  }
  return undefined;
}

/** 1-based line of the first key of the item at `index` in a sequence node. */
function nodeLine(node: unknown, index: number, lines: LineCounter): number | undefined {
  if (!isSeq(node)) return undefined;
  const item = node.items[index];
  if (!isMap(item)) return undefined;
  const first = item.items[0];
  const range = (first?.key as { range?: [number, number, number] } | undefined)?.range;
  return range === undefined ? undefined : lines.linePos(range[0]).line;
}

function sourceOf(file: string, node: unknown, index: number, lines: LineCounter): SourceRef {
  return { file, line: nodeLine(node, index, lines) ?? 1 };
}

function capabilityName(file: string): string {
  return path.posix.basename(file, ".yaml");
}

// --- YAML value -> model. The loader trusts the schema; validate.ts re-checks. ---

function toRule(raw: unknown, source: SourceRef): Rule {
  const value = asRecord(raw);
  const rule: Rule = {
    id: value["id"] as string,
    statement: value["statement"] as string,
    rationale: value["rationale"] as string,
    criticality: value["criticality"] as Criticality,
    status: value["status"] as RuleStatus,
    checks: toArray(value["checks"]).map(toCheckDecl),
    source,
  };
  if (value["owners"] !== undefined) rule.owners = toArray(value["owners"]) as string[];
  if (value["paths"] !== undefined) rule.paths = toArray(value["paths"]) as string[];
  if (value["replaced_by"] !== undefined) rule.replacedBy = value["replaced_by"] as string;
  if (value["retired"] !== undefined) rule.retired = value["retired"] as boolean;
  return rule;
}

function toCheckDecl(raw: unknown): CheckDecl {
  const value = asRecord(raw);
  const check: CheckDecl = { id: value["id"] as string, layer: value["layer"] as CheckLayer };
  if (value["negative_control"] !== undefined) check.negativeControl = toNegativeControl(value["negative_control"]);
  return check;
}

function toNegativeControl(raw: unknown): NegativeControl {
  const value = asRecord(raw);
  return {
    kind: value["kind"] as string,
    seam: value["seam"] as string,
    sabotage: value["sabotage"] as string,
  };
}

function toFlow(raw: unknown, source: SourceRef): Flow {
  const value = asRecord(raw);
  const flow: Flow = {
    id: value["id"] as string,
    name: value["name"] as string,
    owner: value["owner"] as string,
    criticality: value["criticality"] as Criticality,
    steps: toArray(value["steps"]).map(toFlowStep),
    checks: toArray(value["checks"]).map(toFlowCheckDecl),
    source,
  };
  if (value["paths"] !== undefined) flow.paths = toArray(value["paths"]) as string[];
  return flow;
}

function toFlowStep(raw: unknown): FlowStep {
  const value = asRecord(raw);
  return {
    id: value["id"] as string,
    name: value["name"] as string,
    rules: toArray(value["rules"]) as string[],
  };
}

function toFlowCheckDecl(raw: unknown): FlowCheckDecl {
  return { id: asRecord(raw)["id"] as string, layer: asRecord(raw)["layer"] as CheckLayer };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function describe(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
