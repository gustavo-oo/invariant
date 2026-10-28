# no-protection

A fresh repository with no branch protection, no CODEOWNERS file, no doctor
token and no rules. `invariant doctor` must report **G3 (procedural)**, never
G1, and must still run the offline checks (a missing CODEOWNERS is a finding).
