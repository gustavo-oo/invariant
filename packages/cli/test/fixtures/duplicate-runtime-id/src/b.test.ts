import { describe, test } from "vitest";

describe("sales", () => {
  // @check sales.second
  // @rule SALES-010
  test("is idempotent", () => {
    // Same title as src/a.test.ts, so both checks share one runtimeId. R35
    // says that is legal: identity in the execution layer is (file, runtimeId).
  });
});
