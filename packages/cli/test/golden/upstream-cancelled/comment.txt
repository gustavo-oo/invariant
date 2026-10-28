## invariant — G3 (procedural)

**Guarantee class: G3 (procedural).** This run is advisory; a human must act on it.
- Branch-protection observation is unavailable, so the class cannot be G1.
- No credential boundary is declared in .invariant/config.yaml, so the class cannot be G2.

Seam sabotage was NOT executed in this run. No rule is proven able to fail.

**No guarantee is claimed by this run.**

### Gate failures

- `invariant-negative/negative-result.json` upstream.negative_not_executed — the negative control did not execute; no enforced rule is proven
- `invariant-registry/registry-result.json` upstream.job_cancelled — invariant-registry was cancelled

| Flow | Verdict | Step | Rule | Verdict | Check | Reason |
| --- | --- | --- | --- | --- | --- | --- |

### Rules outside any flow

- SALES-004 — A sale MUST NOT complete when stock is insufficient. — blocked (check.blocked), checked
