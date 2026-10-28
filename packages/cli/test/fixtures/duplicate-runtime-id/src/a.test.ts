import { describe, expect, test } from "vitest";
import { submitSale } from "./idempotency";

describe("sales", () => {
  // @check sales.first
  // @rule SALES-010
  test("is idempotent", () => {
    // The committed report supplies the normal-run outcome; this assertion is
    // what makes the sabotaged run fail by assertion.
    expect(submitSale().id).toBe(1);
  });
});
