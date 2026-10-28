/**
 * Minimal JUnit XML reader (PEND-11). It intentionally handles only the subset
 * every JUnit producer emits: `<testcase>` with `name`, an optional `classname`,
 * and a `<failure>` / `<error>` / `<skipped>` child.
 *
 * `runtimeId` is the `testcase name` verbatim. A producer that emits a leaf-only
 * name will not match a discovered `"suite > test"` id and the check stays
 * `not-run`; that is a false red, never a false green. The primary E2E format is
 * Playwright JSON; this reader is a fallback for projects that already write
 * JUnit and whose names match their discovered ids.
 *
 * Malformed XML, a missing `name`, or a document with no `<testcase>` returns
 * `null`, not an empty success.
 */
import type { CheckResult } from "../api.js";

interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attrs: string;
  start: number;
  end: number;
}

/** A tolerant scanner: quoted `>` inside an attribute does not end the tag. */
function* tags(text: string): Generator<Tag> {
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("<", index);
    if (start === -1) return;

    if (text.startsWith("<!--", start)) {
      const end = text.indexOf("-->", start + 4);
      index = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", start)) {
      const end = text.indexOf("]]>", start + 9);
      index = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<?", start)) {
      const end = text.indexOf("?>", start + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }

    let cursor = start + 1;
    const closing = text[cursor] === "/";
    if (closing) cursor += 1;
    const nameStart = cursor;
    while (cursor < text.length && /[A-Za-z0-9_:.-]/.test(text[cursor] ?? "")) cursor += 1;
    const name = text.slice(nameStart, cursor);
    if (name === "") {
      index = start + 1;
      continue;
    }

    let quote: string | null = null;
    let selfClosing = false;
    while (cursor < text.length) {
      const char = text[cursor];
      if (quote !== null) {
        if (char === quote) quote = null;
        cursor += 1;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        cursor += 1;
        continue;
      }
      if (char === ">") {
        selfClosing = text[cursor - 1] === "/";
        cursor += 1;
        break;
      }
      cursor += 1;
    }

    yield { name, closing, selfClosing, attrs: text.slice(nameStart + name.length, cursor - 1), start, end: cursor };
    index = cursor;
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decode(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity: string) => {
    const named = ENTITIES[entity.toLowerCase()];
    if (named !== undefined) return named;
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

function attributes(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of source.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    result[match[1] ?? ""] = decode(match[2] ?? match[3] ?? "");
  }
  return result;
}

function localName(name: string): string {
  return (name.split(":").pop() ?? "").toLowerCase();
}

/** Body text of the first failure/error, for producers without a message attr. */
function failureBody(text: string): string | undefined {
  const match = /<(?:[A-Za-z_][\w.-]*:)?(?:failure|error)\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?(?:failure|error)>/i.exec(text);
  if (match === null) return undefined;
  const body = match[1] ?? "";
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(body);
  const value = cdata?.[1] ?? body;
  return decode(value).trim() === "" ? undefined : decode(value);
}

export function readJunitXml(text: string): CheckResult[] | null {
  const cases: CheckResult[] = [];
  let current: { name: string; outcome: CheckResult["outcome"]; message?: string } | null = null;
  let sawTestcase = false;
  const body = failureBody(text);

  for (const tag of tags(text)) {
    const name = localName(tag.name);

    if (name === "testcase") {
      if (tag.closing) {
        if (current === null) return null;
        cases.push(resultOf(current));
        current = null;
        continue;
      }
      if (current !== null) return null; // nested testcase: not a shape we understand
      const attrs = attributes(tag.attrs);
      const caseName = attrs["name"];
      if (caseName === undefined) return null;
      sawTestcase = true;
      current = { name: caseName, outcome: "pass" };
      if (tag.selfClosing) {
        cases.push(resultOf(current));
        current = null;
      }
      continue;
    }

    if (current === null) continue;

    if (name === "failure" || name === "error") {
      current.outcome = "fail";
      const attrs = attributes(tag.attrs);
      const message = attrs["message"] ?? attrs["type"] ?? body;
      if (message !== undefined) current.message = message;
      continue;
    }

    if (name === "skipped" && current.outcome === "pass") {
      current.outcome = "not-run";
      continue;
    }
  }

  if (!sawTestcase || current !== null) return null;
  return cases;
}

function resultOf(item: { name: string; outcome: CheckResult["outcome"]; message?: string }): CheckResult {
  const result: CheckResult = { runtimeId: item.name, outcome: item.outcome };
  if (item.message !== undefined) result.message = item.message;
  return result;
}
