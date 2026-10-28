## invariant — G3 (procedural)

**Guarantee class: G3 (procedural).** This run is advisory; a human must act on it.
- Branch-protection observation is unavailable, so the class cannot be G1.
- No credential boundary is declared in .invariant/config.yaml, so the class cannot be G2.

### Negative control

Executed — 1 of 1 enforced checks proven able to fail.

**No guarantee is claimed by this run.**

| Flow | Verdict | Step | Rule | Verdict | Check | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| example-request | pass | s1 | EXAMPLE-001 — A request exceeding the injected limit MUST be rejected. (proven) | pass | example.rejects-over-limit | check.passed |
| example-request | pass |  |  | pass | example-request.completes | check.passed |
