# no-op-sabotage

The declared sabotage is a no-op, but Phase 0/1 never applies it: the command
only checks that the file exists and declares a `@seam-alias`. Today's honest
behaviour is exit `0` with `negative_control: "declared-only"`. Phase 2 detects
that the check did not fail under sabotage and this fixture's expected exit code
becomes `1`; until then, a no-op sabotage is **not detectable**.
