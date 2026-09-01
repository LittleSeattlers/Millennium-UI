# Architecture

The system is a serverless public control plane with a private local execution plane.

```text
GitHub Pages UI ── temporary paired session ──► loopback companion ──► local Codex
      ▲                                             │     ▲
      │                                             │     │ trusted context
      └──────── aggregate snapshot ◄── GitHub main ◄┴─────┘
                                           ▲
                                           └── draft claim → sanitized data PR
```

## Public control plane

GitHub Pages hosts only static files and holds no shared credential. GitHub itself supplies a durable contribution ledger, contributor authentication through `gh`, temporary draft-PR claims, pull-request history, validation automation, and the public aggregate snapshot.

The hosted bundle has no native execution ability and no central credential. The explicitly installed Windows connector starts in the contributor's session and is relaunched at Windows sign-in. For each Connect click, the browser creates a random verifier and sends only a request ID plus `base64url(SHA-256(verifier))` to an unframeable approval page on `127.0.0.1`. The verifier is retained briefly in that tab's session storage while it visits the approval page. An explicit local Allow click registers a short-lived, single-use ticket; the page returns to Millennium, removes the verifier, and redeems the ticket for an origin-bound session with a Codex-only API.

The local Allow click is the authorization boundary for pairing one tab. A Start click has a random idempotency identifier and authorizes one exact, bounded task. The connector rejects a start unless at least five safe minutes remain, reserves the final two minutes for durable synthesis, and keeps the absolute quota deadline unchanged. Hosted starts disable research-network access. The companion isolates attempt ownership by browser session, and the browser receives only readiness, safe minutes, reset times, task metadata, a safe terminal category, publication status, and generic events. It cannot list local attempts or read research output, commands, raw quota snapshots, account metadata, executable paths, private files, or credentials.

GitHub project pages share an origin across an account and cannot set an enforceable `frame-ancestors` response header. The UI refuses to render when framed, pairing uses a single-use verifier, and execution still requires explicit Connect and Start gestures. A mature distribution should use a dedicated custom domain, signed installer, and stronger operating-system isolation.

## Private local plane

The installed connector owns quota calculation, Codex subscription authentication, managed Git clones, local task files, provider event streams, checkpoints, and contribution reconstruction. All live work is written under `.millennium/private/`, which is gitignored. The hosted page displays a sanitized estimate but never calculates it or persists its inputs.

Before starting, the connector refreshes `main`, imports up to ten relevant local or maintainer-trusted excerpts into the Codex prompt, checks active claim PRs, and creates its own expiring claim. Static seed tasks plus trusted successor and verification tasks form the executable frontier. All other merged contribution records remain quarantined evidence: visible and countable, but unable to inject instructions into a local Codex run.

## Publication gate

Codex must create `RESULT.md` and `CONTRIBUTION.proposed.json` in its first work cycle, refresh them after material findings or failures, and finalize them during the reserved wrap-up window. The connector never stages the attempt directory. It parses the proposal, discards every unrecognized field, applies length and credential-pattern screening, reconstructs trusted identity fields from runner state, and writes one canonical JSON record. If the proposal is missing or rejected, the connector emits an attempt-specific recovery record with empty claims rather than inventing research content.

The `pull_request_target` workflow uses immutable action revisions and trusted code from `main`. It preflights exactly one regular `100644` blob, requires exact canonical serialization, materializes it into the trusted checkout, validates the complete ledger, rechecks the head and base, and only then squash-merges. It never checks out or executes the pull-request head.
