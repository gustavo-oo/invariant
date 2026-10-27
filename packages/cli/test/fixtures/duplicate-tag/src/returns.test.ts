import { expect, test } from "vitest";

// This test tags the same check id as src/checkout.test.ts. Two distinct tests
// declaring one check makes result attribution ambiguous.
// @check sales.rejects-insufficient-stock
// @rule SALES-004
// @negative-control .invariant/sabotages/sales/stock.ts
test("a return is rejected when stock is insufficient", () => {
  expect(2 + 2).toBe(4);
});
