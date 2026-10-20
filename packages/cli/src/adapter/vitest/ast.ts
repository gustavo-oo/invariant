import { readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { parseTagBlock, type RawTags } from "../../discovery/tags.js";
import type { DiscoveredCheck, DiscoveryError, DiscoveryResult } from "../../discovery/types.js";
import { toPosix } from "../../fsutil.js";

/**
 * The test calls discovery recognizes. `test.skip` and `test.todo` are still
 * discovered: a skipped or todo test is a declared check that must reach the
 * verifier (and become `not-run`), never a check that silently disappears.
 */
const TEST_CALLS = new Set(["test", "it", "test.skip", "it.skip", "test.only", "test.todo"]);

const DESCRIBE = "describe";

/**
 * `fsutil.listFiles` has no brace expansion, so the project's
 * `**\/*.{test,spec}.{ts,tsx,js,jsx,mts,cts}` cannot be expressed as a glob
 * there. Walking and filtering on this suffix is equivalent and explicit.
 */
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx|mts|cts)$/;

const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);

/** A line carrying a tag, whatever else the comment says around it. */
const TAG_LINE = /@(check|rule|flow|negative-control)\s+\S+/;

/** One test call, qualified by the `describe` titles around it. */
interface TestCall {
  testName: string;
  runtimeId: string;
  /** 0-based line of the call's start; `getLineAndCharacterOfPosition` is 0-based. */
  line: number;
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
    return { checks: [], errors: [{ file, line, message: `${file}:${line} could not parse: ${detail}` }] };
  }

  const calls = new Map<number, TestCall>();
  const errors: DiscoveryError[] = [];
  visit(sourceFile, [], calls, sourceFile, errors);
  return { checks: collectChecks(text, file, calls, errors), errors };
}

/** Walk the AST, recording every test call against the suite titles around it. */
function visit(
  node: ts.Node,
  suite: string[],
  calls: Map<number, TestCall>,
  sourceFile: ts.SourceFile,
  errors: DiscoveryError[],
): void {
  if (ts.isCallExpression(node)) {
    const callee = node.expression.getText(sourceFile);

    if (callee === DESCRIBE) {
      const title = staticTitle(node.arguments[0]);
      if (title === null) {
        errors.push({
          file: sourceFile.fileName,
          line: lineOf(node, sourceFile),
          message: "could not resolve a static describe title; the tests inside it cannot be qualified",
        });
        return;
      }
      const body = callbackBody(node);
      if (body !== undefined) visit(body, [...suite, title], calls, sourceFile, errors);
      return;
    }

    if (TEST_CALLS.has(callee)) {
      const title = staticTitle(node.arguments[0]);
      const line = lineOf(node, sourceFile);
      if (title === null) {
        errors.push({ file: sourceFile.fileName, line, message: "could not resolve a static test title" });
        return;
      }
      // First call on a line wins; two calls sharing a line cannot carry distinct
      // tag blocks anyway, because the tags are line-oriented.
      if (!calls.has(line - 1)) {
        calls.set(line - 1, { testName: title, runtimeId: [...suite, title].join(" > "), line: line - 1 });
      }
      return;
    }
  }

  ts.forEachChild(node, (child) => visit(child, suite, calls, sourceFile, errors));
}

/**
 * Attach tag blocks to the test calls they precede. A tag block is attached only
 * when the next non-blank line (after a closing block-comment delimiter) starts
 * the test call; anything else is floating and reported, never guessed at.
 */
function collectChecks(
  text: string,
  file: string,
  calls: Map<number, TestCall>,
  errors: DiscoveryError[],
): DiscoveredCheck[] {
  const lines = text.split("\n");
  const checks: DiscoveredCheck[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!isTagLine(lines[index] ?? "")) {
      index += 1;
      continue;
    }

    const block = parseTagBlock(lines, index);
    if (block === null) {
      errors.push({
        file,
        line: index + 1,
        message: "tag block is not attached to a test call (tags are split by a blank line or another comment)",
      });
      // The whole comment run is ambiguous; skip it rather than re-reading its
      // later tag lines as a second, partial block.
      index = skipCommentRun(lines, index);
      continue;
    }

    const end = index + block.consumed;
    const call = nextCall(lines, end, calls);
    if (call === undefined) {
      errors.push({ file, line: index + 1, message: "tag block is not attached to a test call" });
      index = end;
      continue;
    }

    const check = toCheck(file, block.tags, call, errors);
    if (check !== undefined) checks.push(check);
    index = end;
  }

  return checks;
}

/** The test call whose start is the next non-blank line after `from`, if any. */
function nextCall(lines: string[], from: number, calls: Map<number, TestCall>): TestCall | undefined {
  let index = from;
  while (index < lines.length) {
    const text = (lines[index] ?? "").trim();
    // A bare `*/` closes the tag's own block comment; it is not an intervening
    // comment line between the tags and the test.
    if (text === "" || text === "*/") {
      index += 1;
      continue;
    }
    break;
  }
  return calls.get(index);
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

/** Whether `line` is a comment, reusing the same syntax `parseTagBlock` reads. */
function isCommentLine(line: string): boolean {
  const text = line.trimStart();
  return (
    text.startsWith("//") ||
    (text.startsWith("#") && !text.startsWith("#!")) ||
    text.startsWith("/*") ||
    text.startsWith("*")
  );
}

function isTagLine(line: string): boolean {
  return isCommentLine(line) && TAG_LINE.test(line);
}

function skipCommentRun(lines: string[], from: number): number {
  let index = from;
  while (index < lines.length && isCommentLine(lines[index] ?? "")) index += 1;
  return index;
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
