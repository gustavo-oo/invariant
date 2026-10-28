# sabotage-does-not-compile

The declared sabotage has a syntax error, but Phase 0/1 never compiles or applies
it: the command only checks that the file exists and declares a `@seam-alias`.
Today's honest behaviour is exit `0` with `negative_control: "declared-only"`.
Phase 2 classifies the sabotaged run as `harness` and this fixture's expected
exit code becomes `1`; until then, a broken sabotage is **not detectable**.
