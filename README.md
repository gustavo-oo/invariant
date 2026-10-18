# invariant

> **Under construction.** This repository is in Phase 0+1 of the implementation
> plan — see
> [`docs/superpowers/plans/2026-10-17-invariant-phase-0-1.md`](docs/superpowers/plans/2026-10-17-invariant-phase-0-1.md)
> for the staged plan and
> [`docs/superpowers/specs/2026-10-17-invariant-design.md`](docs/superpowers/specs/2026-10-17-invariant-design.md)
> for the frozen design spec. Nothing here is usable yet.

`invariant` verifies the rules declared under `rules/**` against tests tagged in
a project's own test framework, and reports a verdict per rule.

## Status of this delivery

Seam sabotage is **not** executed in this delivery, so no rule is reported as
"proven" — the verifier can only report what it actually observed.
