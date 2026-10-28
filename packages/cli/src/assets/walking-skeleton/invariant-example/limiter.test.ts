import { expect, test } from "vitest";
import { createLimiter } from "./limiter";

// @check example.rejects-over-limit
// @rule EXAMPLE-001
// @flow example-request/s1
// @negative-control .invariant/sabotages/example/limit-unbounded.ts
test("rejects requests over the injected limit", () => {
  const limiter = createLimiter({ policy: { limit: () => 10 } });
  expect(limiter.request(11)).toEqual({ status: 413 });
  expect(limiter.request(10)).toEqual({ status: 200 });
});

// @check example-request.completes
// @flow example-request
test("completes a request under the limit", () => {
  const limiter = createLimiter({ policy: { limit: () => 10 } });
  expect(limiter.request(1)).toEqual({ status: 200 });
});
