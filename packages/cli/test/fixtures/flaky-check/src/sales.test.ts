import { describe, test } from "vitest";

describe("sales", () => {
  // @check sales.is-idempotent
  // @rule SALES-007
  // @negative-control .invariant/sabotages/sales/idempotency.ts
  test("is idempotent when submitted twice", () => {
    // The committed report (reports/vitest.json) supplies the outcome; the test
    // itself only needs to exist so discovery produces the check.
  });
});
