export interface Policy {
  limit(): number;
}

export function createLimiter({ policy }: { policy: Policy }) {
  return {
    request: (n: number) => (n > policy.limit() ? { status: 413 } : { status: 200 }),
  };
}
