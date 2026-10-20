import { describe, expect, it } from "vitest";
import { parseTagBlock } from "../../src/discovery/tags.js";

describe("parseTagBlock", () => {
  it("reads the four tags from a contiguous comment block, ignoring the rest", () => {
    const lines = [
      "// @check sales.rejects-insufficient-stock",
      "// @rule SALES-004",
      "// @flow checkout/s2",
      "// @negative-control .invariant/sabotages/sales/stock.ts",
      'test("sale is rejected when stock is insufficient", async () => {',
    ];
    expect(parseTagBlock(lines, 0)?.tags).toEqual({
      checks: ["sales.rejects-insufficient-stock"],
      rules: ["SALES-004"],
      flows: [{ flow: "checkout", step: "s2" }],
      negativeControl: [".invariant/sabotages/sales/stock.ts"],
    });
  });

  it("returns null on a blank line or a non-tag comment between tags (no floating tags)", () => {
    expect(parseTagBlock(["// @rule SALES-004", "", "// @check x.y"], 0)).toBeNull();
  });

  it("stops at a non-tag comment line and leaves it for the caller", () => {
    const lines = ["/* @rule SALES-004 */", "/* explanation */", "test("];
    expect(parseTagBlock(lines, 0)?.consumed).toBe(1);
  });

  it("accumulates a tag repeated on the same test", () => {
    const lines = ["// @rule SALES-004", "// @rule STOCK-002", "test("];
    expect(parseTagBlock(lines, 0)?.tags.rules).toEqual(["SALES-004", "STOCK-002"]);
  });

  it("reads # comments for non-JS stacks", () => {
    const lines = ["# @check stock.rejects-negative", "# @flow checkout", "def test_rejects():"];
    expect(parseTagBlock(lines, 0)?.tags).toEqual({
      checks: ["stock.rejects-negative"],
      rules: [],
      flows: [{ flow: "checkout" }],
      negativeControl: [],
    });
  });

  it("reads tags from a multi-line block comment", () => {
    const lines = ["/**", " * @check sales.rejects-insufficient-stock", " * @rule SALES-004", " */", "test("];
    expect(parseTagBlock(lines, 1)).toEqual({
      tags: {
        checks: ["sales.rejects-insufficient-stock"],
        rules: ["SALES-004"],
        flows: [],
        negativeControl: [],
      },
      consumed: 2,
    });
  });

  it("returns null when there is no tag block at the index", () => {
    expect(parseTagBlock(["// just a comment", "test("], 0)).toBeNull();
  });
});
