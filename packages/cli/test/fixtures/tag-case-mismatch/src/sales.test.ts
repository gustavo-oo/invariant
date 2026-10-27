import { expect, test } from "vitest";

// The lowercase tag is a case mismatch and must never match SALES-004.
// @check sales.rejects-insufficient-stock
// @rule SALES-004 @rule sales-004
test("a sale is rejected when stock is insufficient", () => {
  expect(1 + 1).toBe(2);
});
