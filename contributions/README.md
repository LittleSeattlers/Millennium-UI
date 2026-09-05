# Shared research ledger

Millennium persists collaboration as small, reviewable data records rather than publishing a contributor's local Codex workspace.

- `attempts/<problem>/<year>/<attempt-id>.json` contains one canonical, strict-schema contribution envelope with best-effort credential screening.
- `claims/` is reserved for temporary claim files on draft pull-request branches. Claim files are removed before a contribution is eligible to merge, so they normally do not appear on `main`.

Every merged contribution remains `unreviewed`. Version 2 requires one bounded claim, an explicit novelty comparison, evidence, a falsifier, a limitation, and a concrete continuation. This is an information-quality floor, not peer review: a record does not establish correctness, authorship, or eligibility for a Millennium Prize.

Attempts that do not meet the value floor remain private and do not consume their frontier task. The ledger therefore counts accepted research records rather than operational recovery notices.

Automatic merge is persistence, not trust. Unreviewed community prose cannot enter a later Codex prompt or create executable tasks unless its attempt ID is promoted through the separately reviewed `research/trusted-contributions.v1.json` registry.

The automatic merge workflow accepts exactly one newly added contribution JSON file. It reads the pull-request blob through the GitHub API, validates it with trusted code from `main`, and never checks out or executes contributor code.
