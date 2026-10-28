## invariant — G3 (procedural)

**Guarantee class: G3 (procedural).** This run is advisory; a human must act on it.
- Branch-protection observation is unavailable, so the class cannot be G1.
- No credential boundary is declared in .invariant/config.yaml, so the class cannot be G2.

**No guarantee is claimed by this run.**

| Flow | Verdict | Step | Rule | Verdict | Check | Reason |
| --- | --- | --- | --- | --- | --- | --- |

### Rules outside any flow

- SALES-004 — A sale MUST NOT complete when stock is insufficient. — pass (check.passed), proven
