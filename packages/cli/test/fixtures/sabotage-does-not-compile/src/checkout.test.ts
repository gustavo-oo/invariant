import { describe, expect, test } from "vitest";
import { policy } from "./stock-policy";

describe("sales", () => {
  // @check sales.rejects-insufficient-stock
  // @rule SALES-004
  // @negative-control .invariant/sabotages/sales/stock.ts
  test("is rejected when stock is insufficient", () => {
    expect(policy().available()).toBe(1);
  });
});
