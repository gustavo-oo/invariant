## invariant — G3 (procedural)

**Guarantee class: G3 (procedural).** This run is advisory; a human must act on it.
- Branch-protection observation is unavailable, so the class cannot be G1.
- No credential boundary is declared in .invariant/config.yaml, so the class cannot be G2.

Seam sabotage is NOT executed in this delivery (Phase 2). No rule is proven able to fail.

**No guarantee is claimed by this run.**

| Flow | Verdict | Step | Rule | Verdict | Check | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| example-request | pass | s1 | EXAMPLE-001 — A request exceeding the injected limit MUST be rejected. (checked) | pass | example.rejects-over-limit | check.passed |
| example-request | pass |  |  | pass | example-request.completes | check.passed |
