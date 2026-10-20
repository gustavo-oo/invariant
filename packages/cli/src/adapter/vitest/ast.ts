import { readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { parseTagBlock, type RawTags } from "../../discovery/tags.js";
import type { DiscoveredCheck, DiscoveryError, DiscoveryResult } from "../../discovery/types.js";
import { toPosix } from "../../fsutil.js";

/**
 * Calls are classified by their base name plus a whitelist of modifiers, so
 * `describe.only`, `test.concurrent` and `it.only` are the same kinds of call as
 * their undotted twins. The reviewer's whitelist is frozen here: an unknown
 * modifier is reported rather than guessed at.
 */
const MODIFIERS = new Set(["skip", "only", "todo", "concurrent", "fails", "skipIf", "runIf", "each"]);

/** Modifiers that make a call return the actual test/suite call (curried form). */
const CURRIED_MODIFIERS = new Set(["each", "skipIf", "runIf"]);

const SUITE_BASE = "describe";

/**
 * `fsutil.listFiles` has no brace expansion, so the project's
 * `**\/*.{test,spec}.{ts,tsx,js,jsx,mts,cts}` cannot be expressed as a glob
 * there. Walking and filtering on this suffix is equivalent and explicit.
 */
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx|mts|cts)$/;

const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);

/** A comment carrying a tag, whatever else the comment says around it. */
const TAG_LINE = /@(check|rule|flow|negative-control)\s+\S+/;

/** A lexical comment range: only these can ever contribute tags. */
interface CommentRange {
  pos: number;
  end: number;
}

/** One test call, qualified by the `describe` titles around it. */
interface TestCall {
  testName: string;
  runtimeId: string;
  /** 0-based line of the call's start; `getLineAndCharacterOfPosition` is 0-based. */
  line: number;
}

/** A call rooted at `describe`/`test`/`it`, before classification. */
interface CallShape {
  base: "describe" | "test" | "it";
  modifiers: string[];
  curried: boolean;
}

type Classification =
  | { kind: "suite"; shape: CallShape }
  | { kind: "test"; shape: CallShape }
  | { kind: "factory" }
  | { kind: "invalid"; shape: CallShape };

/** The tag block found immediately above one call. */
type AttachedBlock =
  | { kind: "tags"; tags: RawTags; line: number }
  | { kind: "ambiguous"; line: number };

/** Per-file state: the AST, its comments, and what discovery has consumed. */
interface Context {
  file: string;
  text: string;
  sourceFile: ts.SourceFile;
  comments: CommentRange[];
  /** Comment positions already claimed by a call (so they are not floating). */
  consumed: Set<number>;
  checks: DiscoveredCheck[];
  errors: DiscoveryError[];
}

/**
 * TypeScript's public typings omit `parseDiagnostics`, but `createSourceFile`
 * always populates it. Casting to this shape keeps the syntactic-failure check
 * honest without building a whole `Program` just to parse one file.
 */
type SourceFileWithDiagnostics = ts.SourceFile & {
  readonly parseDiagnostics?: readonly ts.DiagnosticWithLocation[];
};

/**
 * Every `*.test.*` / `*.spec.*` file under `root`, repo-relative and sorted.
 * `node_modules`, `dist`, `.git` and every dot directory are skipped: they hold
 * dependencies and build output, never the project's own tests.
 */
export async function listTestFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walk(root, root, files);
  return files.sort();
}

/**
 * Discover one test file. Parse failures are returned as a `DiscoveryError` so a
 * single broken file never aborts the walk and never passes silently.
 */
export function discoverTestFile(file: string, text: string): DiscoveryResult {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true) as SourceFileWithDiagnostics;
  const diagnostic = sourceFile.parseDiagnostics?.[0];
  if (diagnostic !== undefined) {
    const line = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1;
    const detail = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    return { checks: [], errors: [{ file, line, message: `could not parse: ${detail}` }] };
  }

  const context: Context = {
    file,
    text,
    sourceFile,
    comments: collectCommentRanges(sourceFile, text),
    consumed: new Set(),
    checks: [],
    errors: [],
  };
  visit(sourceFile, [], context);
  reportFloatingTags(context);
  return { checks: context.checks, errors: context.errors };
}

/**
 * Walk the AST. Test calls are resolved against their own leading comments, so a
 * tag is attached to a node, never to whatever happens to share its line.
 */
function visit(node: ts.Node, suite: string[], context: Context): void {
  if (ts.isCallExpression(node)) {
    const shape = shapeOf(node);
    if (shape !== null) {
      const classification = classify(shape);
      if (classification.kind === "invalid") {
        reportInvalidShape(node, classification.shape, context);
        return;
      }
      if (classification.kind === "factory") return;
      if (classification.kind === "suite") {
        visitSuite(node, suite, context);
        return;
      }
      visitTest(node, suite, context);
      return;
    }
  }

  ts.forEachChild(node, (child) => visit(child, suite, context));
}

function visitSuite(node: ts.CallExpression, suite: string[], context: Context): void {
  const title = staticTitle(node.arguments[0]);
  const line = lineOf(node, context.sourceFile);
  if (title === null) {
    // The subtree is dropped, so name its location: silently losing tagged tests
    // inside it would be far worse than a visible error.
    context.errors.push({
      file: context.file,
      line,
      message: `could not resolve a static describe title at ${context.file}:${line}; the tests inside this describe are not discovered`,
    });
    return;
  }

  const body = callbackBody(node);
  if (body !== undefined) visit(body, [...suite, title], context);
}

function visitTest(node: ts.CallExpression, suite: string[], context: Context): void {
  const run = attachedRun(node, context);
  const attached = readAttachedTags(run, context);
  // An untagged test is not the plugin's business: computed titles, unusual
  // shapes and table-driven names only matter once a tag block claims the call.
  if (attached === null) return;
  markConsumed(run, context);

  if (attached.kind === "ambiguous") {
    context.errors.push({
      file: context.file,
      line: attached.line,
      message: "tag block is not attached to a test call",
    });
    return;
  }

  const title = staticTitle(node.arguments[0]);
  if (title === null) {
    context.errors.push({
      file: context.file,
      line: lineOf(node, context.sourceFile),
      message: "could not resolve a static test title for a tagged test",
    });
    return;
  }

  const call: TestCall = {
    testName: title,
    runtimeId: [...suite, title].join(" > "),
    line: lineOf(node, context.sourceFile) - 1,
  };
  const check = toCheck(context.file, attached.tags, call, context.errors);
  if (check !== undefined) context.checks.push(check);
}

/**
 * An unclassifiable call is reported by shape. If it owns a tag block, that
 * block is consumed too: "not attached to a test call" would mislabel the real
 * problem (the call shape) and send the reader looking in the wrong place.
 */
function reportInvalidShape(node: ts.CallExpression, shape: CallShape, context: Context): void {
  const run = attachedRun(node, context);
  if (readAttachedTags(run, context) !== null) markConsumed(run, context);
  context.errors.push({
    file: context.file,
    line: lineOf(node, context.sourceFile),
    message: `unrecognized ${shape.base} call shape: ${shapeText(shape)}`,
  });
}

/** The callee chain rooted at `describe`/`test`/`it`, or `null` for other calls. */
function shapeOf(node: ts.CallExpression): CallShape | null {
  let expression: ts.Expression = node.expression;
  let curried = false;

  // Curried form: `test.each(cases)("title", fn)` — the outer call's expression
  // is itself a call; resolve through it to the actual callee chain.
  if (ts.isCallExpression(expression)) {
    curried = true;
    expression = expression.expression;
  }

  const chain = calleeChain(expression);
  if (chain === null) return null;
  const base = chain.base;
  if (base !== "describe" && base !== "test" && base !== "it") return null;
  return { base, modifiers: chain.modifiers, curried };
}

function calleeChain(expression: ts.Expression): { base: string; modifiers: string[] } | null {
  const modifiers: string[] = [];
  let current: ts.Expression = expression;
  while (ts.isPropertyAccessExpression(current)) {
    modifiers.unshift(current.name.text);
    current = current.expression;
  }
  if (!ts.isIdentifier(current)) return null;
  return { base: current.text, modifiers };
}

function classify(shape: CallShape): Classification {
  const unique = new Set(shape.modifiers);
  if (unique.size !== shape.modifiers.length) return { kind: "invalid", shape };
  if (!shape.modifiers.every((modifier) => MODIFIERS.has(modifier))) return { kind: "invalid", shape };

  const curriedModifier = shape.modifiers.some((modifier) => CURRIED_MODIFIERS.has(modifier));
  if (shape.curried && !curriedModifier) return { kind: "invalid", shape };
  // `test.each(cases)` without the trailing title/callback is a factory, not a
  // test: there is nothing to discover and nothing to report.
  if (!shape.curried && curriedModifier) return { kind: "factory" };

  if (shape.base === SUITE_BASE) return { kind: "suite", shape };
  return { kind: "test", shape };
}

/** `test.skip`, `describe.each(...)` — a stable name for error messages. */
function shapeText(shape: CallShape): string {
  const dotted = [shape.base, ...shape.modifiers].join(".");
  return shape.curried ? `${dotted}(...)` : dotted;
}

/**
 * The contiguous comment run that ends immediately before `node`: every gap
 * between ranges, and between the last range and the call, must be whitespace
 * with at most one line break. A blank line therefore breaks attachment.
 *
 * Only the AST's own leading trivia is considered (R24/R25). There is no
 * fallback: a comment the AST does not report as leading to this call is not
 * this call's tag, and tag-like text inside a token (a template body, JSX text)
 * is never trivia in the first place.
 */
function attachedRun(node: ts.Node, context: Context): CommentRange[] {
  const start = node.getStart(context.sourceFile);
  const ranges = (ts.getLeadingCommentRanges(context.text, node.getFullStart()) ?? []).filter(
    (range) => range.end <= start,
  );

  const run: CommentRange[] = [];
  let boundary = start;
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index];
    if (range === undefined) continue;
    if (!isAttachedGap(context.text.slice(range.end, boundary))) break;
    run.unshift({ pos: range.pos, end: range.end });
    boundary = range.pos;
  }

  // R24(a): the block must open its own line. A comment trailing a previous
  // statement belongs to that statement, not to the call below it.
  const first = run[0];
  if (first === undefined || !startsOwnLine(context.text, first.pos)) return [];
  return run;
}

/** Whitespace only, with at most one line break; `\n\n` (a blank line) fails. */
function isAttachedGap(gap: string): boolean {
  return /^[ \t]*\r?\n?[ \t]*$/.test(gap);
}

/** Whether only whitespace precedes `position` on its line. */
function startsOwnLine(text: string, position: number): boolean {
  const lineStart = text.lastIndexOf("\n", position - 1) + 1;
  return /^[ \t]*$/.test(text.slice(lineStart, position));
}

/**
 * Read the tag block out of an attached comment run. `parseTagBlock`'s
 * `consumed` still defines where the block ends; starting at the first tag line
 * lets a `/**` doc block's first line legitimately return `null`.
 *
 * R24(c): the block must run right up to the call. If another comment range
 * begins after the block ends (an explanatory line between tags and test), the
 * tags are floating, not attached.
 */
function readAttachedTags(run: CommentRange[], context: Context): AttachedBlock | null {
  const first = run[0];
  const last = run[run.length - 1];
  if (first === undefined || last === undefined) return null;

  const lines = context.text.slice(first.pos, last.end).split("\n");
  const tagIndex = lines.findIndex((line) => TAG_LINE.test(line));
  if (tagIndex === -1) return null;

  const line = context.sourceFile.getLineAndCharacterOfPosition(first.pos).line + 1 + tagIndex;
  const block = parseTagBlock(lines, tagIndex);
  if (block === null) return { kind: "ambiguous", line };

  const blockEnd = first.pos + offsetAfterLines(lines, tagIndex + block.consumed);
  if (run.some((range) => range.pos >= blockEnd)) return { kind: "ambiguous", line };

  return { kind: "tags", tags: block.tags, line };
}

/** Offset just past `count` newline-terminated lines of `lines`. */
function offsetAfterLines(lines: string[], count: number): number {
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    offset += (lines[index] ?? "").length + 1;
  }
  return offset;
}

function markConsumed(run: CommentRange[], context: Context): void {
  for (const range of run) context.consumed.add(range.pos);
}

/**
 * Every tag-bearing comment that no call consumed is floating. This is derived
 * from node-derived comment ranges, so tag-like text inside a string, template
 * body or JSX text can never become a tag.
 */
function reportFloatingTags(context: Context): void {
  for (const range of context.comments) {
    if (!TAG_LINE.test(context.text.slice(range.pos, range.end))) continue;
    if (context.consumed.has(range.pos)) continue;
    context.errors.push({
      file: context.file,
      line: context.sourceFile.getLineAndCharacterOfPosition(range.pos).line + 1,
      message: "tag block is not attached to a test call",
    });
  }
}

/**
 * Every real comment range in the file, from node trivia only (R25). Walking the
 * AST and each node's children covers every token's leading/trailing trivia;
 * template bodies and JSX text are token text, so tag-like lines inside them are
 * never collected. Ranges are deduplicated by position and sorted.
 */
function collectCommentRanges(sourceFile: ts.SourceFile, text: string): CommentRange[] {
  const ranges = new Map<number, CommentRange>();
  const opaque: CommentRange[] = [];
  const walkTrivia = (node: ts.Node): void => {
    if (isOpaqueToken(node)) opaque.push({ pos: node.getStart(sourceFile), end: node.getEnd() });
    for (const range of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) {
      ranges.set(range.pos, { pos: range.pos, end: range.end });
    }
    // Trailing ranges are needed only for floating reporting: the AST treats a
    // same-line comment as the previous token's trailing trivia, not as the
    // next call's leading trivia.
    for (const range of ts.getTrailingCommentRanges(text, node.getEnd()) ?? []) {
      ranges.set(range.pos, { pos: range.pos, end: range.end });
    }
    for (const child of node.getChildren(sourceFile)) walkTrivia(child);
  };
  walkTrivia(sourceFile);
  return [...ranges.values()]
    .filter((range) => !opaque.some((span) => range.pos >= span.pos && range.pos < span.end))
    .sort((left, right) => left.pos - right.pos);
}

/**
 * Tokens whose text is not code. `getLeadingCommentRanges` scans raw text and
 * can mistake `//` inside a template body or JSX text for a comment; a range
 * starting inside one of these spans is never a comment.
 */
function isOpaqueToken(node: ts.Node): boolean {
  switch (node.kind) {
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.RegularExpressionLiteral:
    case ts.SyntaxKind.TemplateHead:
    case ts.SyntaxKind.TemplateMiddle:
    case ts.SyntaxKind.TemplateTail:
    case ts.SyntaxKind.JsxText:
    case ts.SyntaxKind.JsxTextAllWhiteSpaces:
      return true;
    default:
      return false;
  }
}

/** Resolve one attached block into a check, or report why it cannot be one. */
function toCheck(
  file: string,
  tags: RawTags,
  call: TestCall,
  errors: DiscoveryError[],
): DiscoveredCheck | undefined {
  // PEND-3: a discovered test declares exactly one check. Zero is an
  // undeclared test; two or more cannot be attributed without guessing.
  if (tags.checks.length !== 1) {
    errors.push({
      file,
      line: call.line + 1,
      message: `expected exactly one @check on a test call, found ${tags.checks.length}`,
    });
    return undefined;
  }
  // PEND-4: the registry's declared negative-control path is authoritative; the
  // tag is a single optional value, so more than one is ambiguous.
  if (tags.negativeControl.length > 1) {
    errors.push({
      file,
      line: call.line + 1,
      message: `expected at most one @negative-control on a test call, found ${tags.negativeControl.length}`,
    });
    return undefined;
  }

  const checkId = tags.checks[0];
  if (checkId === undefined) return undefined;

  const check: DiscoveredCheck = {
    checkId,
    rules: tags.rules,
    flows: tags.flows,
    testName: call.testName,
    file,
    line: call.line + 1,
    frameworkId: "vitest",
    runtimeId: call.runtimeId,
  };
  const negativeControl = tags.negativeControl[0];
  if (negativeControl !== undefined) check.negativeControl = negativeControl;
  return check;
}

function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** The first string/template title of a call, or `null` when it is computed. */
function staticTitle(argument: ts.Expression | undefined): string | null {
  if (argument === undefined) return null;
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) return argument.text;
  return null;
}

/** The body of the first arrow/function callback argument, if there is one. */
function callbackBody(node: ts.CallExpression): ts.Node | undefined {
  for (const argument of node.arguments) {
    if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) return argument.body;
  }
  return undefined;
}

async function walk(root: string, directory: string, into: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    // A directory that vanished mid-walk is no matches; any other failure must
    // propagate rather than make an unreadable tree look like an untested one.
    if (isNotFound(cause)) return;
    throw cause;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) continue;
      await walk(root, path.join(directory, entry.name), into);
    } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
      into.push(toPosix(path.relative(root, path.join(directory, entry.name))));
    }
  }
}

function isNotFound(cause: unknown): boolean {
  return cause instanceof Error && (cause as NodeJS.ErrnoException).code === "ENOENT";
}
