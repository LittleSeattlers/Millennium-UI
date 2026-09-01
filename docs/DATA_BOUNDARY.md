# Public data boundary

`Millennium-UI` publishes bounded research knowledge through a strict contribution envelope. The local connector can read public `main` and write through the contributor's own GitHub identity, but the hosted page has no credential and the repository never receives access to private local files.

## Allowed fields

Version 1 contribution records allow only:

- Runner-supplied attempt, problem, route, time, and selected-task identifiers.
- Terminal status and the fixed initial review status `unreviewed`.
- One bounded summary.
- Atomic claims with an explicit confidence label, evidence summary, and verification method.
- Limitations, failed approaches, and next actions.
- Zero to three bounded successor-task proposals.
- Public HTTP(S) citations with query strings, fragments, private hosts, local names, and literal IPv6 hosts removed or rejected.
- Up to ten prior public attempt IDs consulted by the run.

The runner reconstructs the published object from this allowlist; it never copies a model-produced object or directory wholesale.

## Forbidden fields

Do not publish:

- A contributor-identity field, email address, or account metadata. GitHub still visibly attributes the pull request to the account that opened it.
- Provider, model, configuration, or adapter details.
- Token usage, subscription status, remaining quota, or budget telemetry.
- Local paths, commands, environment information, or event streams.
- Raw logs, hidden reasoning, arbitrary artifacts, source code, or executable content.
- Credentials, authorization headers, API keys, passwords, or credential-like tokens.

These fields remain forbidden even when a text sanitizer appears to remove obvious secrets. The raw attempt workspace is never staged, unsupported keys fail validation, and known credential formats are rejected across the complete serialized record. No deterministic filter can prove arbitrary model prose contains no creatively encoded secret, so Start is the publication authorization boundary and unreviewed community prose is quarantined from future executable prompts.

The paired hosted control may transiently display an allowlisted model catalog returned by the local connector: model ID, display name, short description, default marker, and supported reasoning levels. This catalog is used only to choose the local run configuration. It excludes account and service-tier data and is never copied into a public contribution record.

## Counting rules

- Discover only `contributions/attempts/<problem>/<year>/<attempt-id>.json`.
- Skip directories and files beginning with `.`.
- Never follow symbolic links.
- Reject unknown fields, problems, states, duplicate IDs or JSON keys, malformed JSON, credential-pattern violations, non-regular blobs, and non-canonical layouts or serialization.
- Count each valid terminal record as one run. `interrupted`, `aborted`, and `failed` records are grouped as partial/stopped in the aggregate dashboard.
- Fail closed: one invalid included record aborts the export.

## Review gate

A draft claim is never mergeable. At completion the connector's branch removes the claim file and contains exactly one new contribution JSON file while retaining an expiring claim marker in the PR body. The privileged merge workflow checks the head tree mode, canonical bytes, full-ledger uniqueness, head SHA, and base repository immediately before squash merge. It does not check out or execute contributor-controlled code.

All mathematical content remains unreviewed after merge. Automatic acceptance means only that the data boundary passed—not that any claim is correct, novel, or prize-eligible.

Merged records do not become Codex context merely because they passed the data boundary. Only IDs explicitly listed in `research/trusted-contributions.v1.json` through the ordinary reviewed code path can influence later prompts or create executable successor tasks.
