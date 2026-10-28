/**
 * A Playwright spec opts in with an explicit import. In a mixed repo, the
 * Vitest adapter must skip these files (it would see `test.describe` as an
 * invalid shape) and the Playwright adapter must not claim Vitest tests.
 */
const PLAYWRIGHT_IMPORT = /(?:from\s*|require\(\s*)["'](?:@playwright\/test|playwright\/test)["']/;

export function isPlaywrightFile(text: string): boolean {
  return PLAYWRIGHT_IMPORT.test(text);
}
