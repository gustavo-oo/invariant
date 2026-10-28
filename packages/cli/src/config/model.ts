/**
 * The configuration shape (`.invariant/config.yaml`) and its documented
 * defaults. A repo with `rules/` but no `.invariant/config.yaml` must run on
 * these defaults (review focus 1).
 */

/** Scope mode: `advisory` reports, `blocking` fails the gate. */
export type ScopeMode = "advisory" | "blocking";

/** How the agent skill is distributed. */
export type SkillDistribution = "manifest-only" | "opencode" | "both";

/** PEND-2: only an explicit human declaration can yield G2. */
export type CredentialBoundary = "declared" | "none";

export interface Config {
  /** The first configured adapter; kept for compatibility with Phase 0/1. */
  adapter: string;
  /** Every adapter that participates in one gate, in discovery order. */
  adapters: string[];
  scope: { mode: ScopeMode };
  skill: { distribution: SkillDistribution };
  doctor: { apiUrl: string; tokenEnv: string; expectedAppId: number };
  ruleChange: { label: string };
  credentialBoundary: CredentialBoundary;
  protectedPaths: string[];
}

/** The documented defaults, applied for every absent property. */
export const DEFAULT_CONFIG: Config = {
  adapter: "vitest",
  adapters: ["vitest"],
  scope: { mode: "advisory" },
  skill: { distribution: "manifest-only" },
  doctor: {
    apiUrl: "https://api.github.com",
    tokenEnv: "INVARIANT_DOCTOR_TOKEN",
    expectedAppId: 15368,
  },
  ruleChange: { label: "invariant:rule-change" },
  credentialBoundary: "none",
  protectedPaths: ["rules/", ".invariant/", ".github/workflows/invariant.yml", ".github/CODEOWNERS"],
};
