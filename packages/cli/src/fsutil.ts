import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Read `file` as UTF-8, strip a leading BOM and normalize CRLF/CR to LF, so
 * Windows checkouts and editors never leak into parsing (review focus 3).
 */
export async function readText(file: string): Promise<string> {
  const text = await readFile(file, "utf8");
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutBom.replace(/\r\n?/g, "\n");
}

/** A path with `/` separators, whatever the platform. */
export function toPosix(file: string): string {
  return file.split(path.sep).join("/");
}

/**
 * Every file under `root` whose repo-relative, POSIX-separated path matches
 * `glob`. Supports `**` (any number of segments), `*` and `?` within a segment.
 * Returns sorted repo-relative paths; a missing directory is simply no matches.
 */
export async function listFiles(root: string, glob: string): Promise<string[]> {
  const pattern = toPosix(glob);
  const base = path.join(root, ...fixedPrefix(pattern));
  const files: string[] = [];
  await walk(base, files);
  return files
    .map((file) => toPosix(path.relative(root, file)))
    .filter((file) => matchGlob(pattern, file))
    .sort();
}

/**
 * Normalize a repo-relative path and reject absolute paths or paths that escape
 * `root`. Returns the normalized, POSIX-separated path.
 */
export function assertInsideRepo(root: string, relative: string): string {
  if (path.isAbsolute(relative)) {
    throw new Error(`invariant: expected a repo-relative path, got ${relative}`);
  }
  const normalized = toPosix(path.normalize(relative));
  const back = path.relative(root, path.resolve(root, relative));
  const escapes = back === ".." || back.startsWith(`..${path.sep}`) || path.isAbsolute(back);
  if (normalized === ".." || normalized.startsWith("../") || escapes) {
    throw new Error(`invariant: path escapes the repo: ${relative}`);
  }
  return normalized;
}

async function walk(dir: string, into: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // A missing (or unreadable) directory has no matches.
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, into);
    else if (entry.isFile()) into.push(full);
  }
}

/** The literal leading directories of a glob, up to its first magic segment. */
function fixedPrefix(pattern: string): string[] {
  const fixed: string[] = [];
  for (const segment of pattern.split("/")) {
    if (segment.includes("*") || segment.includes("?")) break;
    fixed.push(segment);
  }
  return fixed;
}

function matchGlob(pattern: string, file: string): boolean {
  return matchSegments(pattern.split("/"), file.split("/"));
}

function matchSegments(pattern: readonly string[], segments: readonly string[]): boolean {
  const head = pattern[0];
  if (head === undefined) return segments.length === 0;
  if (head === "**") {
    // `**` matches zero or more whole segments.
    if (matchSegments(pattern.slice(1), segments)) return true;
    return segments.length > 0 && matchSegments(pattern, segments.slice(1));
  }
  const segment = segments[0];
  if (segment === undefined || !matchSegment(head, segment)) return false;
  return matchSegments(pattern.slice(1), segments.slice(1));
}

function matchSegment(pattern: string, segment: string): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${source}$`).test(segment);
}
