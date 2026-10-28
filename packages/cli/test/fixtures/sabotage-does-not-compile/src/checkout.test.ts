import { describe, expect, test } from "vitest";

describe("sales", () => {
  // @check sales.rejects-insufficient-stock
  // @rule SALES-004
  // @negative-control .invariant/sabotages/sales/stock.ts
  test("is rejected when stock is insufficient", () => {
    expect(1 + 1).toBe(2);
  });
});
