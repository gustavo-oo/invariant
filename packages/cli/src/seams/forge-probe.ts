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
import { observeFromApi } from "../doctor/github.js";
import { resolveRepo } from "../doctor/probe.js";

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

/** Task 18 wires the GitHub REST observation; the seam stays the only entry point. */
export function createForgeProbe(config: Config): ForgeProbe {
  return {
    async observe(root: string): Promise<DoctorObservation> {
      const token = process.env[config.doctor.tokenEnv] ?? null;
      if (token === null || token.trim() === "") {
        return { available: false, reason: `no token for ${config.doctor.tokenEnv}` };
      }
      const repo = await resolveRepo(root);
      if (repo === null) {
        return {
          available: false,
          reason: "cannot determine the GitHub repository from GITHUB_REPOSITORY or origin",
        };
      }
      return await observeFromApi(globalThis.fetch, {
        owner: repo.owner,
        name: repo.name,
        token,
        apiUrl: config.doctor.apiUrl,
      });
    },
  };
}
