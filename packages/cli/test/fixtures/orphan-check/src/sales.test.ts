import { expect, test } from "vitest";

// The one real tagged test in this fixture implements the draft rule's check.
// SALES-004's declared check has no test at all: that is the defect.
// @check sales.records-total
// @rule SALES-005
test("records the sale total", () => {
  expect(10 + 5).toBe(15);
});
