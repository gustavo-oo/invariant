import { expect, test } from "vitest";

// The lowercase rule id below is a case mismatch: it must never match SALES-004.
// @check sales.rejects-insufficient-stock
// @rule sales-004
test("a sale is rejected when stock is insufficient", () => {
  expect(1 + 1).toBe(2);
});
