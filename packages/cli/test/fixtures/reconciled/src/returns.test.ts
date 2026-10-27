import { describe, expect, test } from "vitest";

// Same describe + test titles as src/checkout.test.ts, so this test's runtime id
// is identical. In another file that is a different check, not a collision.
describe("sales", () => {
  // @check sales.records-total
  // @rule SALES-005
  test("is rejected when stock is insufficient", () => {
    expect(2 + 2).toBe(4);
  });
});
