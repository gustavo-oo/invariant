import { describe, expect, it } from "vitest";
import { findAdapter } from "../../src/adapter/registry.js";
import { makeTmpRepo } from "../helpers/fixture.js";

const vitest = findAdapter("vitest")!;

describe("vitest discovery", () => {
  it("discovers tagged tests through the AST with suite-qualified runtime ids", async () => {
    const root = await makeTmpRepo({
      "src/sale.test.ts": `
      import { describe, test } from "vitest";
      describe("sales", () => {
        // @check sales.rejects-insufficient-stock
        // @rule SALES-004
        // @flow checkout/s2
        test("rejects insufficient stock", () => {});
      });
    `,
    });
    const { checks, errors } = await vitest.discover(root);
    expect(errors).toEqual([]);
    expect(checks).toEqual([
      {
        checkId: "sales.rejects-insufficient-stock",
        rules: ["SALES-004"],
        flows: [{ flow: "checkout", step: "s2" }],
        testName: "rejects insufficient stock",
        file: "src/sale.test.ts",
        line: 7,
        frameworkId: "vitest",
        runtimeId: "sales > rejects insufficient stock",
      },
    ]);
  });

  it("reports a floating tag block as an error instead of guessing", async () => {
    const root = await makeTmpRepo({ "src/x.test.ts": "// @rule SALES-004\n\nconst x = 1;\n" });
    const { checks, errors } = await vitest.discover(root);
    expect(checks).toEqual([]);
    expect(errors[0]?.message).toContain("tag block is not attached to a test call");
  });

  it("reports an unparseable file as an error (never a silent skip)", async () => {
    const root = await makeTmpRepo({ "src/bad.test.ts": "test( " });
    const { errors } = await vitest.discover(root);
    expect(errors[0]?.message).toContain("could not parse");
  });

  it("never attaches a tag block above a describe to its first test", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": `
        import { describe, test } from "vitest";
        // @check sales.whole-suite
        describe("sales", () => {
          test("unguarded", () => {});
          // @check sales.guarded
          test("guarded", () => {});
        });
      `,
    });
    const { checks, errors } = await vitest.discover(root);
    expect(checks.map((check) => check.checkId)).toEqual(["sales.guarded"]);
    expect(errors[0]?.message).toContain("tag block is not attached to a test call");
  });

  it("reports a test with no @check instead of silently skipping it", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": `
        import { test } from "vitest";
        // @rule SALES-004
        test("has no check", () => {});
      `,
    });
    const { checks, errors } = await vitest.discover(root);
    expect(checks).toEqual([]);
    expect(errors[0]?.message).toContain("exactly one @check");
  });

  it("reports a test with two @check tags", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": `
        import { test } from "vitest";
        // @check sales.one
        // @check sales.two
        test("ambiguous", () => {});
      `,
    });
    const { checks, errors } = await vitest.discover(root);
    expect(checks).toEqual([]);
    expect(errors[0]?.message).toContain("exactly one @check");
  });

  it("reports more than one @negative-control on one test", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": `
        import { test } from "vitest";
        // @check sales.one
        // @negative-control .invariant/sabotages/a.ts
        // @negative-control .invariant/sabotages/b.ts
        test("ambiguous sabotage", () => {});
      `,
    });
    const { checks, errors } = await vitest.discover(root);
    expect(checks).toEqual([]);
    expect(errors[0]?.message).toContain("@negative-control");
  });

  it("discovers todo and skipped tests, and never treats describe as a check", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": `
        import { describe, test } from "vitest";
        describe("sales", () => {
          // @check sales.later
          test.todo("later");
          // @check sales.skipped
          test.skip("skipped", () => {});
        });
      `,
    });
    const { checks, errors } = await vitest.discover(root);
    expect(errors).toEqual([]);
    expect(checks.map((check) => check.checkId)).toEqual(["sales.later", "sales.skipped"]);
  });

  it("skips node_modules, dist and dot directories", async () => {
    const tagged = (id: string) => `import { test } from "vitest";\n// @check ${id}\ntest("x", () => {});\n`;
    const root = await makeTmpRepo({
      "src/x.test.ts": tagged("src.check"),
      "node_modules/pkg/y.test.ts": tagged("dep.check"),
      "dist/z.test.ts": tagged("dist.check"),
      ".hidden/w.test.ts": tagged("hidden.check"),
    });
    const { checks } = await vitest.discover(root);
    expect(checks.map((check) => check.checkId)).toEqual(["src.check"]);
  });

  it("ignores tag-like text inside a template literal before a test", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": [
        "const body = `",
        "// @check fake.id",
        "`;",
        'test("real", () => {});',
        "",
      ].join("\n"),
    });
    const { checks, errors } = await vitest.discover(root);
    expect(checks).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("ignores tag-like text inside a template literal before non-test code", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": [
        "const body = `",
        "// @check fake.id",
        "`;",
        "const x = 1;",
        "",
      ].join("\n"),
    });
    const { checks, errors } = await vitest.discover(root);
    expect(checks).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("treats a tag block above a one-line describe as floating, even when a test shares the line", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": [
        'import { describe, test } from "vitest";',
        "// @check sales.whole-suite",
        'describe("sales", () => { test("t", () => {}); });',
        "",
      ].join("\n"),
    });
    const { checks, errors } = await vitest.discover(root);
    expect(checks).toEqual([]);
    expect(errors[0]?.message).toContain("tag block is not attached to a test call");
  });

  it("qualifies tagged tests inside describe.only", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": [
        'import { describe, test } from "vitest";',
        'describe.only("sales", () => {',
        "  // @check sales.only",
        '  test("t", () => {});',
        "});",
        "",
      ].join("\n"),
    });
    const { checks, errors } = await vitest.discover(root);
    expect(errors).toEqual([]);
    expect(checks[0]?.runtimeId).toBe("sales > t");
  });

  it("discovers tagged it.only and test.concurrent calls", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": [
        'import { it, test } from "vitest";',
        "// @check sales.it",
        'it.only("it only", () => {});',
        "// @check sales.concurrent",
        'test.concurrent("concurrent", () => {});',
        "",
      ].join("\n"),
    });
    const { checks, errors } = await vitest.discover(root);
    expect(errors).toEqual([]);
    expect(checks.map((check) => check.checkId)).toEqual(["sales.it", "sales.concurrent"]);
  });

  it("discovers a curried test.each call", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": [
        'import { test } from "vitest";',
        "// @check sales.each",
        'test.each([{ n: 1 }])("each", () => {});',
        "",
      ].join("\n"),
    });
    const { checks, errors } = await vitest.discover(root);
    expect(errors).toEqual([]);
    expect(checks[0]?.runtimeId).toBe("each");
  });

  it("reports an unclassifiable dotted call shape instead of guessing", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": [
        'import { test } from "vitest";',
        "// @check sales.unknown",
        'test.failsEach("unknown", () => {});',
        "",
      ].join("\n"),
    });
    const { checks, errors } = await vitest.discover(root);
    expect(checks).toEqual([]);
    expect(errors[0]?.message).toContain("unrecognized test call shape");
    expect(errors[0]?.message).toContain("test.failsEach");
  });

  it("does not error on an untagged computed-title test", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": ['test(`a ${1}`, () => {});', ""].join("\n"),
    });
    const { checks, errors } = await vitest.discover(root);
    expect(checks).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("reports a computed title when a tag block attaches", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": ["// @check sales.dynamic", 'test(`a ${1}`, () => {});', ""].join("\n"),
    });
    const { checks, errors } = await vitest.discover(root);
    expect(checks).toEqual([]);
    expect(errors[0]?.message).toContain("could not resolve a static test title");
  });

  it("attaches a JSDoc tag block to the test below it", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": ["/**", " * @check sales.doc", " */", 'test("doc", () => {});', ""].join("\n"),
    });
    const { checks, errors } = await vitest.discover(root);
    expect(errors).toEqual([]);
    expect(checks[0]?.checkId).toBe("sales.doc");
  });

  it("does not attach a tag block separated from the test by a blank line", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": ["// @check sales.detached", "", 'test("detached", () => {});', ""].join("\n"),
    });
    const { checks, errors } = await vitest.discover(root);
    expect(checks).toEqual([]);
    expect(errors[0]?.message).toContain("tag block is not attached to a test call");
  });

  it("names the file and line of a describe whose computed title drops its subtree", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": [
        "describe(`suite ${1}`, () => {",
        "  // @check sales.inner",
        '  test("inner", () => {});',
        "});",
        "",
      ].join("\n"),
    });
    const { checks, errors } = await vitest.discover(root);
    expect(checks).toEqual([]);
    expect(errors[0]?.message).toContain("could not resolve a static describe title");
    expect(errors[0]?.message).toContain("src/x.test.ts:1");
  });

  it("ignores tag-like text after a template substitution", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": [
        "const s = `v=${1}",
        "// @check fake.id`;",
        'test("real", () => {});',
        "",
      ].join("\n"),
    });
    const { checks, errors } = await vitest.discover(root);
    expect(checks).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("does not report tag-like template text after a substitution as floating", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": [
        "const s = `v=${1}",
        "// @check fake.id`;",
        "const x = 1;",
        "",
      ].join("\n"),
    });
    const { checks, errors } = await vitest.discover(root);
    expect(checks).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("reports an orphan tag after a computed-title test instead of dropping it", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": [
        "test(`a ${1}`, () => {});",
        "// @check orphan.id",
        "",
        "const x = 1;",
        "",
      ].join("\n"),
    });
    const { checks, errors } = await vitest.discover(root);
    expect(checks).toEqual([]);
    expect(errors[0]?.message).toContain("tag block is not attached to a test call");
  });

  it("ignores tag-like text inside JSX text", async () => {
    const root = await makeTmpRepo({
      "src/x.test.tsx": [
        'import { test } from "vitest";',
        "const view = (",
        "  <div>",
        "    // @check fake.id",
        "  </div>",
        ");",
        'test("real", () => {});',
        "",
      ].join("\n"),
    });
    const { checks, errors } = await vitest.discover(root);
    expect(checks).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("does not attach a trailing same-line tag to the next test", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": [
        'test("first", () => {}); // @check first.id',
        'test("second", () => {});',
        "",
      ].join("\n"),
    });
    const { checks, errors } = await vitest.discover(root);
    expect(checks).toEqual([]);
    expect(errors[0]?.message).toContain("tag block is not attached to a test call");
  });

  it("does not attach a trailing tag on a preceding statement to the next test", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": [
        "const x = 1; // @check nope.id",
        'test("real", () => {});',
        "",
      ].join("\n"),
    });
    const { checks, errors } = await vitest.discover(root);
    expect(checks).toEqual([]);
    expect(errors[0]?.message).toContain("tag block is not attached to a test call");
  });

  it("does not attach a tag block with a non-tag comment line before the call", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": [
        "// @check sales.x",
        "// an explanatory note",
        'test("t", () => {});',
        "",
      ].join("\n"),
    });
    const { checks, errors } = await vitest.discover(root);
    expect(checks).toEqual([]);
    expect(errors[0]?.message).toContain("tag block is not attached to a test call");
  });

  it("handles the curried describe.runIf form with its suite title", async () => {
    const root = await makeTmpRepo({
      "src/x.test.ts": [
        'import { describe, test } from "vitest";',
        'describe.runIf(true)("sales", () => {',
        "  // @check sales.run-if",
        '  test("t", () => {});',
        "});",
        "",
      ].join("\n"),
    });
    const { checks, errors } = await vitest.discover(root);
    expect(errors).toEqual([]);
    expect(checks[0]?.runtimeId).toBe("sales > t");
  });
});
