# `flaky-check` — a synthetic report capture

The test is written because discovery needs a real tagged test; the outcome comes
from `reports/vitest.json`, which is **not** a capture of a real Vitest run.

Vitest 3.2.7's JSON reporter does not emit `retryCount` at all (see
`src/adapter/vitest/report.ts`), so `flaky` can only be produced by a reporter
that does. This fixture hand-writes `retryCount: 2` with `status: "passed"` to
pin the two facts that must not regress:

- a pass recorded after retries is `flaky`, never green (`readReports`);
- the roll-up turns that check into a red rule and exit `1`.

If a future Vitest version starts emitting `retryCount`, replace this file with
a real capture and delete this note.
