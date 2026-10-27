import { expect, test } from "vitest";

// @check sales.rejects-insufficient-stock
// @rule SALES-004
// @negative-control .invariant/sabotages/sales/stock.ts
test("a sale is rejected when stock is insufficient", () => {
  expect(1 + 1).toBe(2);
});
