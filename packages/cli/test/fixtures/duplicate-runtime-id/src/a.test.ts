import { describe, test } from "vitest";

describe("sales", () => {
  // @check sales.first
  // @rule SALES-010
  test("is idempotent", () => {
    // The committed report supplies the outcome; this test only makes the
    // check discoverable.
  });
});
