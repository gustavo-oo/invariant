import { test } from "vitest";

// @check sales.never-runs
// @rule SALES-004
test.skip("never runs", () => {
  // The point of this fixture: the test exists and is skipped, so the check is
  // discovered but never executes.
});
