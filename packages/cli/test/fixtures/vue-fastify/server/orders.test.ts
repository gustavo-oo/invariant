import { expect, test } from "vitest";
import { createInventory } from "./inventory";
import { placeOrder } from "./orders";

// @check orders.accepts-available
// @rule ORDERS-001
// @flow checkout/s2
// @negative-control .invariant/sabotages/server/inventory.ts
test("accepts an order when stock is available", () => {
  expect(placeOrder(createInventory())).toBe(201);
});
