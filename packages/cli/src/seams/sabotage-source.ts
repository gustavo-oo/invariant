/**
 * The sabotage-source seam (spec §7, SELF-004).
 *
 * `checkDeclared` reads every enforced check's sabotage through this module, so
 * Phase 2 can replace it and prove the declaration check can fail. `read` is
 * total: a path outside the repo, a missing file or an unreadable file yields
 * `null`, never an exception. `seamAlias` is the single `@seam-alias` value when
 * there is exactly one; duplicates stay visible in `text` so the caller can tell
 * "missing" from "more than one".
 */
import path from "node:path";
import { assertInsideRepo, readText } from "../fsutil.js";

export interface SabotageFile {
  text: string;
  seamAlias: string | null;
}

export interface SabotageSource {
  read(repoRelativePath: string): Promise<SabotageFile | null>;
}

const SEAM_ALIAS = /@seam-alias[ \t]+(\S+)/g;

export function createSabotageSource(root: string): SabotageSource {
  return {
    async read(repoRelativePath: string): Promise<SabotageFile | null> {
      let relative: string;
      try {
        relative = assertInsideRepo(root, repoRelativePath);
      } catch {
        return null;
      }
      let text: string;
      try {
        text = await readText(path.join(root, relative));
      } catch {
        return null;
      }
      const aliases = [...text.matchAll(SEAM_ALIAS)].map((match) => match[1] ?? "");
      return { text, seamAlias: aliases.length === 1 ? aliases[0] ?? null : null };
    },
  };
}
