/**
 * The human artefact: a PR comment. Renders, in this order, the class heading,
 * the class banner with its reasons, the declared-only negative-control banner,
 * the below-G1 warning, the zero-enforced-rules notice, the gate-failure list (a
 * red gate must say why, R51), the per-flow table and a per-rule list for rules
 * that no flow names.
 *
 * Every piece of registry prose is escaped before it enters a cell: a rule
 * statement is business prose (often Portuguese) and may contain `|`,
 * backticks, `*` or newlines, any of which would silently break the table
 * (review focus 2). The table pipes `renderComment` generates are never escaped.
 */
import type { GuaranteeClass } from "../guarantee/class.js";
import type { Report, WireFinding, WireRuleVerdict } from "./shape.js";

const MECHANISM: Record<GuaranteeClass, string> = {
  G1: "observed",
  G2: "declared",
  G3: "procedural",
};

const DECLARED_ONLY_BANNER = "Seam sabotage is NOT executed in this delivery (Phase 2). No rule is proven able to fail.";
const CLASS_WARNING = "**No guarantee is claimed by this run.**";
const NO_ENFORCED_RULES = "No enforced rules are declared";

/** Render the PR comment. Pure: the report is the only input. */
export function renderComment(report: Report): string {
  const { guarantee } = report;
  const blocks: string[] = [heading(guarantee.class), classBanner(guarantee.class, guarantee.binding, guarantee.class_reasons)];

  if (guarantee.negative_control === "declared-only") blocks.push(DECLARED_ONLY_BANNER);
  if (guarantee.class !== "G1") blocks.push(CLASS_WARNING);

  // A gate failure stopped the run before any rule could be evaluated: "No
  // enforced rules are declared" would describe the registry, not the failure
  // the `### Gate failures` section is about. Keep it for real 0/1 runs.
  const enforced = report.rules.filter((rule) => rule.status === "enforced").length;
  if (enforced === 0 && report.exit_code !== 2) blocks.push(NO_ENFORCED_RULES);

  if (report.exit_code === 2 && report.integrity.length > 0) {
    blocks.push(renderGateFailures(report.integrity));
  }

  // A protected-path change is a product failure (exit 1), so it never reaches
  // the gate-failure list. Gate on the finding, not on the recorded list: a
  // local or merge_group audit records changed paths without failing the run
  // (R54), and must not claim the run cannot be green. Without this section a
  // red run whose rules are all green would render as an all-green table (R69).
  const protectedPaths = report.immutability.protected_paths_changed;
  const protectedFailure = report.integrity.some(
    (finding) => finding.code === "immutability.protected_path_changed",
  );
  if (protectedFailure && protectedPaths.length > 0 && !report.immutability.flagged) {
    blocks.push(renderProtectedPaths(protectedPaths));
  }

  blocks.push(renderTable(report));

  const outside = rulesOutsideFlows(report);
  if (outside.length > 0) blocks.push(renderOutsideList(outside));

  return blocks.join("\n\n") + "\n";
}

function heading(cls: GuaranteeClass): string {
  return `## invariant — ${cls} (${MECHANISM[cls]})`;
}

function classBanner(cls: GuaranteeClass, binding: boolean, reasons: string[]): string {
  const claim = binding ? "This run is binding on the merge." : "This run is advisory; a human must act on it.";
  const lines = [`**Guarantee class: ${cls} (${MECHANISM[cls]}).** ${claim}`];
  for (const reason of reasons) lines.push(`- ${escapeText(reason)}`);
  return lines.join("\n");
}

function renderTable(report: Report): string {
  const lines = [
    "| Flow | Verdict | Step | Rule | Verdict | Check | Reason |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of tableRows(report)) {
    lines.push(`| ${row.join(" | ")} |`);
  }
  return lines.join("\n");
}

/**
 * One row per (flow, step, rule, check); flows, steps, rules and check ids are
 * sorted by id. The verdict after `Rule` is the rule's, so a red rule is visible
 * even when its individual checks are green. Flow-level checks render with an
 * empty step/rule cell. A flow with no steps and no checks still gets a row so
 * its verdict cannot disappear.
 */
function tableRows(report: Report): string[][] {
  const ruleById = new Map(report.rules.map((rule) => [rule.rule_id, rule]));
  const checkById = new Map(report.checks.map((check) => [check.check_id, check]));
  const rows: string[][] = [];

  for (const flow of sortBy(report.flows, (item) => item.flow_id)) {
    let flowRows = 0;

    for (const step of sortBy(flow.steps, (item) => item.step_id)) {
      for (const ruleId of sortStrings(step.rule_ids)) {
        const rule = ruleById.get(ruleId);
        const checkIds = rule?.check_ids ?? [];
        const ruleCell = ruleText(rule, ruleId);

        if (checkIds.length === 0) {
          rows.push([
            cell(flow.flow_id),
            cell(flow.verdict),
            cell(step.step_id),
            ruleCell,
            cell(rule?.verdict ?? ""),
            "",
            cell(rule?.reason ?? ""),
          ]);
          flowRows += 1;
        }
        for (const checkId of checkIds) {
          rows.push([
            cell(flow.flow_id),
            cell(flow.verdict),
            cell(step.step_id),
            ruleCell,
            cell(rule?.verdict ?? ""),
            cell(checkId),
            cell(rule?.reason ?? ""),
          ]);
          flowRows += 1;
        }
      }
    }

    for (const checkId of sortStrings(flow.check_ids)) {
      const check = checkById.get(checkId);
      // A declared flow check with no discovered test has no CheckVerdict; the
      // flow's own verdict and reason already name that check as the cause.
      rows.push([
        cell(flow.flow_id),
        cell(flow.verdict),
        "",
        "",
        cell(check?.verdict ?? flow.verdict),
        cell(checkId),
        cell(check?.reason ?? flow.reason),
      ]);
      flowRows += 1;
    }

    if (flowRows === 0) {
      rows.push([cell(flow.flow_id), cell(flow.verdict), "", "", "", "", cell(flow.reason)]);
    }
  }

  return rows;
}

/** `SALES-004 — <escaped statement> (checked|proven)`; `proven` only with a proof. */
function ruleText(rule: WireRuleVerdict | undefined, ruleId: string): string {
  if (rule === undefined) return cell(ruleId);
  const statement = rule.statement === "" ? "" : ` — ${escapeText(rule.statement)}`;
  return `${cell(rule.rule_id)}${statement} (${rule.sabotage_verified ? "proven" : "checked"})`;
}

/**
 * The gate's own failure list (R51). A cancelled worker or a missing artifact
 * makes the report exit 2 with no product verdict to explain it; without this
 * section the rule table would render all-green and the reason would live only
 * in the JSON artifact. Each line names the artifact it is about, because two
 * missing artifacts otherwise render identically. Codes, files and messages are
 * data from upstream artifacts, so they are escaped like any other cell.
 */
function renderGateFailures(findings: WireFinding[]): string {
  const lines = ["### Gate failures", ""];
  for (const finding of findings) {
    const file = finding.file === "" ? "" : `\`${cell(finding.file)}\` `;
    lines.push(`- ${file}${cell(finding.code)} — ${cell(finding.message)}`);
  }
  return lines.join("\n");
}

/**
 * A protected-path change is a red product finding, not a broken gate. The
 * table below would show only the (green) rules, so name the paths explicitly.
 */
function renderProtectedPaths(paths: string[]): string {
  const lines = ["### Protected paths changed", ""];
  for (const file of sortStrings(paths)) lines.push(`- \`${cell(file)}\``);
  lines.push("", "A protected path changed outside the flagged rule-change path; this run cannot be green.");
  return lines.join("\n");
}

function rulesOutsideFlows(report: Report): WireRuleVerdict[] {
  const inFlow = new Set<string>();
  for (const flow of report.flows) {
    for (const step of flow.steps) {
      for (const ruleId of step.rule_ids) inFlow.add(ruleId);
    }
  }
  return sortBy(
    report.rules.filter((rule) => !inFlow.has(rule.rule_id)),
    (rule) => rule.rule_id,
  );
}

function renderOutsideList(rules: WireRuleVerdict[]): string {
  const lines = ["### Rules outside any flow", ""];
  for (const rule of rules) {
    const statement = rule.statement === "" ? "" : ` — ${escapeText(rule.statement)}`;
    const proof = rule.sabotage_verified ? "proven" : "checked";
    lines.push(`- ${cell(rule.rule_id)}${statement} — ${rule.verdict} (${rule.reason}), ${proof}`);
  }
  return lines.join("\n");
}

/**
 * Escape `\` first — otherwise existing sequences such as `\|`, `` \` `` or
 * `\*` would still split a cell once GFM unescapes `\\` — then collapse every
 * newline (CRLF included) to one space and escape the other hostile
 * characters. Escaping happens on plain text, before any table cell is built.
 */
function escapeText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`")
    .replace(/\*/g, "\\*");
}

/** A dynamic table cell. Generated pipes are added by the caller, never here. */
function cell(text: string): string {
  return escapeText(text);
}

function sortStrings(values: readonly string[]): string[] {
  return [...values].sort(compare);
}

function sortBy<T>(items: readonly T[], id: (item: T) => string): T[] {
  return [...items].sort((a, b) => compare(id(a), id(b)));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
