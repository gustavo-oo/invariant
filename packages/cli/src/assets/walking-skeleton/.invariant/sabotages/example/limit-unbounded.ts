// @seam-alias invariant-example/limiter.ts
export function createLimiter() {
  return { request: () => ({ status: 200 }) };
}
