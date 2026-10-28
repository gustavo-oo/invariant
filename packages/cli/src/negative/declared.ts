/**
 * Spec §8 stage 6 in declaration form (PEND-1): every enforced rule's check
 * must name a sabotage file, that file must declare exactly one `@seam-alias`,
 * and the alias must point at an existing file inside the repo, other than the
 * sabotage itself. Nothing is executed here; Phase 2 applies the sabotage.
 *
 * The read goes through `SabotageSource` so the SELF-004 seal is real: a check
 * that opened the file directly would keep working after Phase 2 replaces the
 * seam, and its sabotage would be a no-op (spec §7).
 */
import { statSync } from "node:fs";
import path from "node:path";
import { assertInsideRepo } from "../fsutil.js";
import type { CheckDecl, Finding, Registry, Rule } from "../registry/model.js";
import { createSabotageSource, type SabotageSource } from "../seams/sabotage-source.js";

const SEAM_ALIAS = /@seam-alias[ \t]+(\S+)/g;

/**
 * Walk every enforced rule's checks and return one finding per broken
 * declaration. A check without `negative_control` is skipped: `validateRegistry`
 * already owns that code (`registry.enforced_without_negative_control`), and
 * reporting it twice would make one defect look like two.
 */
export async function checkDeclared(
  registry: Registry,
  root: string,
  source: SabotageSource = createSabotageSource(root),
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const rule of registry.rules) {
    if (rule.status !== "enforced") continue;
    for (const check of rule.checks) {
      findings.push(...(await checkOne(rule, check, root, source)));
    }
  }
  return findings;
}

async function checkOne(
  rule: Rule,
  check: CheckDecl,
  root: string,
  source: SabotageSource,
): Promise<Finding[]> {
  const declared = check.negativeControl;
  if (declared === undefined) return [];

  const sabotage = declared.sabotage;
  const identity = { file: sabotage, ruleId: rule.id, checkId: check.id };
  let sabotagePath: string;
  try {
    sabotagePath = assertInsideRepo(root, sabotage);
  } catch {
    return [
      {
        ...identity,
        code: "negative.sabotage_missing",
        message: `check ${check.id} declares a sabotage that is not a repo-relative path: ${sabotage}`,
      },
    ];
  }

  const file = await source.read(sabotagePath);
  if (file === null) {
    return [
      {
        ...identity,
        code: "negative.sabotage_missing",
        message: `check ${check.id} declares a sabotage that does not exist: ${sabotage}`,
      },
    ];
  }

  const aliases = [...file.text.matchAll(SEAM_ALIAS)].map((match) => match[1] ?? "");
  if (aliases.length === 0) {
    return [
      {
        ...identity,
        code: "negative.seam_alias_missing",
        message: `sabotage ${sabotage} has no @seam-alias <path> comment`,
      },
    ];
  }
  if (aliases.length > 1) {
    return [
      {
        ...identity,
        code: "negative.seam_alias_duplicate",
        message: `sabotage ${sabotage} declares ${aliases.length} @seam-alias comments; exactly one is required`,
      },
    ];
  }

  const alias = file.seamAlias ?? aliases[0] ?? "";
  return aliasFindings(identity, alias, sabotagePath, root);
}

function aliasFindings(
  identity: Omit<Finding, "code" | "message">,
  alias: string,
  sabotagePath: string,
  root: string,
): Finding[] {
  const invalid = (reason: string): Finding[] => [
    {
      ...identity,
      code: "negative.seam_alias_target_invalid",
      message: `@seam-alias ${alias} ${reason}`,
    },
  ];

  if (path.isAbsolute(alias)) {
    return invalid("must be a repo-relative path inside the repository");
  }
  let target: string;
  try {
    target = assertInsideRepo(root, alias);
  } catch {
    return invalid("escapes the repository");
  }
  if (target === sabotagePath) {
    return invalid("points at the sabotage file itself");
  }

  let stat;
  try {
    stat = statSync(path.join(root, target));
  } catch {
    return invalid("does not name an existing file");
  }
  if (!stat.isFile()) return invalid("does not name a regular file");

  return [];
}
