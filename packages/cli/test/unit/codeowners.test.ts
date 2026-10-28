import { describe, expect, it } from "vitest";
import { coversPaths, parseCodeowners, sizeOk } from "../../src/doctor/codeowners.js";

describe("parseCodeowners (spec §9.2 caveat)", () => {
  it("reports the syntax errors GitHub silently skips", () => {
    const { errors } = parseCodeowners(
      [
        "/rules/ @alice",
        "!/rules/secret/ @alice",
        "/.invariant/",
        "/bad/ @alice @",
        "/bad2/ \\#",
        "/bad3/ alice",
      ].join("\n"),
    );

    expect(errors.map((error) => error.kind).sort()).toEqual([
      "invalid_pattern",
      "invalid_pattern",
      "negation",
      "ownerless",
      "unknown_owner_kind",
    ]);
    expect(errors.every((error) => error.line > 0 && error.message.length > 0)).toBe(true);
  });

  it("keeps comments, blank lines and section headers out of the rules", () => {
    const { rules, errors } = parseCodeowners(
      ["# owners", "", "[Rules]", "/rules/ @alice", "[Docs]", "docs/ @org/docs"].join("\n"),
    );

    expect(errors).toEqual([]);
    expect(rules).toEqual([
      { pattern: "/rules/", owners: ["@alice"], line: 4, negated: false, section: "Rules" },
      { pattern: "docs/", owners: ["@org/docs"], line: 6, negated: false, section: "Docs" },
    ]);
  });

  it("accepts @user, @org/team and email owners", () => {
    const { rules, errors } = parseCodeowners(
      ["/a/ @alice", "/b/ @org/team", "/c/ legal@example.com"].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(rules.map((rule) => rule.owners)).toEqual([
      ["@alice"],
      ["@org/team"],
      ["legal@example.com"],
    ]);
  });

  it("reports exactly one error per bad line and never throws", () => {
    const parsed = parseCodeowners("[unclosed\n!/x/\n/y/\n/z/ @\n");
    expect(parsed.errors.map((error) => error.kind)).toEqual([
      "invalid_pattern",
      "negation",
      "ownerless",
      "invalid_pattern",
    ]);
  });
});

describe("coversPaths", () => {
  it("resolves coverage with last-match-wins and requires an owner for each protected path", () => {
    const { rules } = parseCodeowners(
      ["/rules/ @alice", "/rules/ @bob", "/.invariant/ @alice"].join("\n"),
    );

    expect(coversPaths(rules, ["rules/self.yaml"])).toEqual([
      { path: "rules/self.yaml", owner: "@bob" },
    ]);
    expect(coversPaths(rules, ["/etc/passwd"])).toEqual([{ path: "/etc/passwd", owner: null }]);
  });

  it("flags a covered file's owner and leaves an uncovered path ownerless", () => {
    const { rules } = parseCodeowners("/rules/ @alice\n/.github/CODEOWNERS @alice\n");
    expect(coversPaths(rules, [".github/CODEOWNERS"])).toEqual([
      { path: ".github/CODEOWNERS", owner: "@alice" },
    ]);
    expect(coversPaths(rules, ["README.md"])).toEqual([{ path: "README.md", owner: null }]);
  });

  it("matches directories below the repo root, exact files and * / ** globs", () => {
    const { rules } = parseCodeowners(
      [
        "/rules/ @rules",
        "*.md @docs",
        "/src/**/*.ts @code",
        "/.github/workflows/invariant.yml @gate",
      ].join("\n"),
    );

    expect(coversPaths(rules, ["rules/a.yaml", "deep/rules/b.yaml", "README.md", "src/a.ts", "src/nested/b.ts", ".github/workflows/invariant.yml"]).map((item) => item.owner)).toEqual([
      "@rules",
      null,
      "@docs",
      "@code",
      "@code",
      "@gate",
    ]);
  });

  it("ignores negated and ownerless lines instead of letting them clear an owner", () => {
    const { rules } = parseCodeowners(["/rules/ @alice", "!/rules/private/ @bob", "/.invariant/"].join("\n"));
    expect(coversPaths(rules, ["rules/private/x.yaml"]).map((item) => item.owner)).toEqual([
      "@alice",
    ]);
  });

  it("never matches an absolute or escaping path", () => {
    const { rules } = parseCodeowners("/rules/ @alice\n");
    expect(coversPaths(rules, ["/rules/x.yaml", "../rules/x.yaml"]).map((item) => item.owner)).toEqual([
      null,
      null,
    ]);
  });
});

describe("sizeOk", () => {
  it("accepts a file below the 3 MB limit and rejects the boundary", () => {
    expect(sizeOk(3 * 1024 * 1024 - 1)).toBe(true);
    expect(sizeOk(3 * 1024 * 1024)).toBe(false);
    expect(sizeOk(-1)).toBe(false);
    expect(sizeOk(Number.NaN)).toBe(false);
  });
});
