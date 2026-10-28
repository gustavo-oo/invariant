/**
 * The forge probe seam (SELF-005, spec §9.3).
 *
 * Task 18 owns the GitHub REST implementation; this delivery only fixes the
 * interface and a stub so the composition root (`context.ts`) can hand `verify`
 * a probe without the command ever constructing one by hand. That indirection is
 * what makes the SELF-005 sabotage able to replace it in Phase 2.
 *
 * `observe` is total by contract: it never throws. An unavailable observation
 * carries the reason, and an unavailable observation can never produce G1
 * (`computeClass`) — absence of an observation is not evidence of protection.
 */
import type { Config } from "../config/model.js";

/**
 * What the forge actually protects, as read from the API. The shape is the
 * plan's (Task 18) and is deliberately narrow: the class decision needs the
 * wrapper and app pinning, not the forge's full payload.
 */
export type DoctorObservation =
  | {
      available: true;
      repo: { owner: string; name: string; defaultBranch: string; visibility: "public" | "private" };
      protection: {
        mechanism: "ruleset" | "branch-protection" | "none";
        requiredContexts: { context: string; appId: number | null }[];
        codeOwnerReview: boolean;
        bypassActors: { type: string; id: number | null; mode: string }[];
        mergeQueue: "enabled" | "unknown";
      };
    }
  | { available: false; reason: string };

/** The seam SELF-005 sabotages: one method, no policy. */
export interface ForgeProbe {
  observe(root: string): Promise<DoctorObservation>;
}

/** Task 18 replaces only this body with the GitHub-backed probe. */
export function createForgeProbe(_config: Config): ForgeProbe {
  return {
    async observe(): Promise<DoctorObservation> {
      return { available: false, reason: "forge probe is wired in a later task" };
    },
  };
}
