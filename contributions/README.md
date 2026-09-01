# Shared research ledger

Millennium persists collaboration as small, reviewable data records rather than publishing a contributor's local Codex workspace.

- `attempts/<problem>/<year>/<attempt-id>.json` contains one canonical, strict-schema contribution envelope with best-effort credential screening.
- `claims/` is reserved for temporary claim files on draft pull-request branches. Claim files are removed before a contribution is eligible to merge, so they normally do not appear on `main`.

Every merged contribution remains `unreviewed`. A record proves only that a bounded attempt was reported; it does not establish correctness, novelty, authorship, or eligibility for a Millennium Prize.

Automatic merge is persistence, not trust. Unreviewed community prose cannot enter a later Codex prompt or create executable tasks unless its attempt ID is promoted through the separately reviewed `research/trusted-contributions.v1.json` registry.

The automatic merge workflow accepts exactly one newly added contribution JSON file. It reads the pull-request blob through the GitHub API, validates it with trusted code from `main`, and never checks out or executes contributor code.
