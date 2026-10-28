import { expect, test } from "vitest";
import { submitOrder } from "./checkout";

// @check checkout.ui-accepts-order
// @rule CHECKOUT-001
// @flow checkout/s1
// @negative-control .invariant/sabotages/client/api.ts
test("accepts an order through the injected client", () => {
  expect(submitOrder()).toBe("accepted");
});
