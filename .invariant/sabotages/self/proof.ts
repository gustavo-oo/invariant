// @seam-alias packages/cli/src/verdict/proof.ts
// A sabotaged decision table: every outcome counts as proof, so SELF-004's
// expectation (`[false, false, true, false, false]`) must fail by assertion.
export function isProof() {
  return true;
}
