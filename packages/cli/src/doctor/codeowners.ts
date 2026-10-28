/**
 * CODEOWNERS parsing for `doctor` (spec §9.2/§9.3.5).
 *
 * GitHub **silently skips** a CODEOWNERS line it cannot parse, so a typo makes
 * the owner requirement disappear without any signal. This parser reports the
 * syntax problems instead of reproducing that silence. It never throws: a bad
 * line becomes one error and the rest of the file stays usable.
 *
 * Coverage follows GitHub's "last matching pattern wins" rule. Negated lines
 * are reported (`!` is not supported in CODEOWNERS) and never match; invalid or
 * ownerless lines are omitted from `rules`, because GitHub would not use them.
 */
import path from "node:path";
import { toPosix } from "../fsutil.js";

export interface CodeownersRule {
  /** The pattern without a leading `!`; a leading `/` means repo-root relative. */
  pattern: string;
  owners: string[];
  /** 1-based line in the file. */
  line: number;
  negated: boolean;
  /** The most recent `[Section]` header, or null. */
  section: string | null;
}

export type CodeownersErrorKind =
  | "ownerless"
  | "negation"
  | "invalid_pattern"
  | "unknown_owner_kind";

export interface CodeownersError {
  line: number;
  message: string;
  kind: CodeownersErrorKind;
}

export interface ParsedCodeowners {
  rules: CodeownersRule[];
  errors: CodeownersError[];
}

/** GitHub refuses a CODEOWNERS file at or above this size (3 MB). */
export const CODEOWNERS_MAX_BYTES = 3 * 1024 * 1024;

export function sizeOk(bytes: number): boolean {
  return Number.isFinite(bytes) && bytes >= 0 && bytes < CODEOWNERS_MAX_BYTES;
}

export function parseCodeowners(text: string): ParsedCodeowners {
  const rules: CodeownersRule[] = [];
  const errors: CodeownersError[] = [];
  let section: string | null = null;

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const raw = lines[index] ?? "";
    const withoutComment = stripComment(raw).trim();
    if (withoutComment === "") continue;

    const header = sectionHeader(withoutComment);
    if (header !== undefined) {
      if (header === null) {
        errors.push({
          line,
          kind: "invalid_pattern",
          message: "a section header must be [name] with a closing bracket",
        });
      } else {
        section = header;
      }
      continue;
    }

    const tokens = withoutComment.split(/\s+/);
    const first = tokens[0] ?? "";
    const negated = first.startsWith("!");
    const pattern = negated ? first.slice(1) : first;

    if (pattern === "" || pattern.includes("\\")) {
      errors.push({
        line,
        kind: "invalid_pattern",
        message: negated
          ? "a negated pattern needs a path after `!`"
          : "CODEOWNERS does not support backslash escaping",
      });
      continue;
    }
    if (negated) {
      errors.push({
        line,
        kind: "negation",
        message: "GitHub CODEOWNERS does not support `!` negation; this line would be ignored",
      });
    }

    const ownerTokens = tokens.slice(1);
    if (ownerTokens.length === 0) {
      // A negated line already has its one error; do not add a second.
      if (!negated) {
        errors.push({
          line,
          kind: "ownerless",
          message: `pattern ${pattern} has no owner`,
        });
      }
      continue;
    }

    const badOwner = ownerTokens.find((token) => ownerProblem(token) !== null);
    if (badOwner !== undefined) {
      // One error per line: a negated line's syntax error is already reported.
      if (!negated) {
        const problem = ownerProblem(badOwner);
        errors.push({
          line,
          kind: problem === "unknown_owner_kind" ? "unknown_owner_kind" : "invalid_pattern",
          message: problem === "unknown_owner_kind"
            ? `${badOwner} is neither @user, @org/team nor an email`
            : `${badOwner} is not a valid owner token`,
        });
      }
      continue;
    }

    // A negated line is kept for diagnostics, but `coversPaths` never uses it.
    rules.push({
      pattern,
      owners: ownerTokens,
      line,
      negated,
      section,
    });
  }

  return { rules, errors };
}

/**
 * Resolve the owner of each path. The last matching pattern wins, as on GitHub;
 * a path no pattern covers must be reported as `owner: null`. Absolute paths are
 * not repo-relative and can never be covered.
 */
export function coversPaths(
  rules: CodeownersRule[],
  paths: string[],
): { path: string; owner: string | null }[] {
  return paths.map((repoPath) => {
    const normalized = normalizePath(repoPath);
    if (normalized === null) return { path: repoPath, owner: null };

    let owner: string | null = null;
    for (const rule of rules) {
      if (rule.negated || rule.owners.length === 0) continue;
      if (matches(rule.pattern, normalized)) owner = rule.owners[0] ?? null;
    }
    return { path: repoPath, owner };
  });
}

/** A `#` starts a comment; the parser never treats it as part of a pattern. */
function stripComment(line: string): string {
  const hash = line.indexOf("#");
  return hash === -1 ? line : line.slice(0, hash);
}

/** `[Section]` → its name; a malformed `[` → null; not a header → undefined. */
function sectionHeader(line: string): string | null | undefined {
  if (!line.startsWith("[")) return undefined;
  const close = line.indexOf("]");
  if (close === -1) return null;
  return line.slice(1, close).trim();
}

function normalizePath(value: string): string | null {
  if (value === "" || value.startsWith("/")) return null;
  const normalized = toPosix(path.normalize(value));
  if (normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

/** GitHub owner forms: @user, @org/team, or an email address. */
function ownerProblem(token: string): "invalid_pattern" | "unknown_owner_kind" | null {
  if (token.includes("\\")) return "invalid_pattern";
  if (token.startsWith("@")) {
    if (/^@[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)?$/.test(token)) return null;
    return "invalid_pattern";
  }
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(token)) return null;
  return "unknown_owner_kind";
}

/**
 * Translate a CODEOWNERS pattern to a RegExp.
 *
 * - A leading `/` anchors at the repo root; without it, the pattern matches at
 *   any depth (GitHub's rule for patterns without a leading slash).
 * - A trailing `/` covers the directory and everything below it.
 * - `*` never crosses `/`; `**` does; `?` is one non-`/` character.
 */
function matches(pattern: string, file: string): boolean {
  const rootRelative = pattern.startsWith("/");
  const body = rootRelative ? pattern.slice(1) : pattern;
  const directory = body.endsWith("/");
  const trimmed = directory ? body.slice(0, -1) : body;
  if (trimmed === "") return false;

  const source = globSource(trimmed);
  const prefix = rootRelative ? "^" : "^(?:.*/)?";
  const suffix = directory ? "(?:/.*)?$" : "$";
  return new RegExp(`${prefix}${source}${suffix}`).test(file);
}

function globSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === undefined) break;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        // `**/` matches zero or more whole directories, so `src/**/*.ts`
        // matches `src/a.ts` as well as `src/nested/b.ts`.
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return source;
}
