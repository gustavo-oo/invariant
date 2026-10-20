import type { FlowRef } from "./types.js";

/**
 * The tags carried by one contiguous comment block, before discovery resolves
 * them against the registry. Every tag is a list because a tag may repeat on
 * the same test (`@rule A` and `@rule B`); duplicates *across* tests are an
 * integrity problem for Task 8, not for this parser.
 */
export interface RawTags {
  checks: string[];
  rules: string[];
  flows: FlowRef[];
  negativeControl: string[];
}

/** A contiguous run of tag comments, and how many lines it covers. */
interface ParsedTagBlock {
  tags: RawTags;
  consumed: number;
}

/**
 * Parse the comment block starting at `lines[index]`.
 *
 * A block is a run of *contiguous* comment lines that each carry at least one
 * tag. It ends at the first blank line, non-tag comment or code line, and
 * `consumed` counts the tag lines only.
 *
 * Returns `null` when there is no tag block at `index`, and also when the block
 * is ambiguous: if a tag line reappears after the run broke (a blank line, a
 * non-tag comment) but before the next statement, the tags are floating and
 * cannot be attributed to one test. Task 5 turns that case into a
 * `DiscoveryError` rather than guessing.
 *
 * Lines are expected to be BOM- and CRLF-normalized by `readText`; this parser
 * never reads files and never throws on malformed input.
 */
export function parseTagBlock(lines: string[], index: number): ParsedTagBlock | null {
  const tags = emptyTags();
  let consumed = 0;

  while (index + consumed < lines.length) {
    const line = lines[index + consumed];
    if (line === undefined) break;
    const content = commentContent(line);
    if (content === null) break;
    const found = extractTags(content);
    if (isEmpty(found)) break;
    append(tags, found);
    consumed += 1;
  }

  if (consumed === 0) return null;
  if (hasFloatingTag(lines, index + consumed)) return null;
  return { tags, consumed };
}

/**
 * The text of `line` when it is a comment, or `null` when it is not. Supports
 * `//` and `#` line comments and slash-star block comments, including
 * `*`-decorated continuation lines of a multi-line block.
 */
function commentContent(line: string): string | null {
  const text = line.trimStart();
  if (text.startsWith("//")) return text.slice(2);
  if (text.startsWith("#") && !text.startsWith("#!")) return text.slice(1);
  if (text.startsWith("/*")) {
    const close = text.indexOf("*/", 2);
    return close === -1 ? text.slice(2) : text.slice(2, close);
  }
  if (text.startsWith("*")) {
    const close = text.indexOf("*/");
    return close === -1 ? text.slice(1) : text.slice(1, close);
  }
  return null;
}

/**
 * Every recognized tag in one comment's text. A tag needs a value: a lone
 * `@check` is malformed and contributes nothing, so it cannot keep a block
 * alive on its own.
 */
function extractTags(content: string): RawTags {
  const tags = emptyTags();
  for (const match of content.matchAll(/@(check|rule|flow|negative-control)\s+(\S+)/g)) {
    const name = match[1];
    const value = match[2];
    if (name === undefined || value === undefined) continue;
    if (name === "check") tags.checks.push(value);
    else if (name === "rule") tags.rules.push(value);
    else if (name === "flow") tags.flows.push(parseFlow(value));
    else tags.negativeControl.push(value);
  }
  return tags;
}

/** `checkout` is a whole flow; `checkout/s2` is one of its steps. */
function parseFlow(value: string): FlowRef {
  const slash = value.indexOf("/");
  if (slash === -1) return { flow: value };
  const flow = value.slice(0, slash);
  const step = value.slice(slash + 1);
  return step === "" ? { flow } : { flow, step };
}

/**
 * Whether another tag line follows the run before the next statement, which
 * would make the block floating (and therefore ambiguous).
 */
function hasFloatingTag(lines: string[], start: number): boolean {
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.trim() === "") continue;
    const content = commentContent(line);
    if (content === null) return false;
    if (!isEmpty(extractTags(content))) return true;
  }
  return false;
}

function emptyTags(): RawTags {
  return { checks: [], rules: [], flows: [], negativeControl: [] };
}

function isEmpty(tags: RawTags): boolean {
  return (
    tags.checks.length === 0 &&
    tags.rules.length === 0 &&
    tags.flows.length === 0 &&
    tags.negativeControl.length === 0
  );
}

function append(into: RawTags, from: RawTags): void {
  into.checks.push(...from.checks);
  into.rules.push(...from.rules);
  into.flows.push(...from.flows);
  into.negativeControl.push(...from.negativeControl);
}
