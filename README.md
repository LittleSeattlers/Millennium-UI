# Millennium UI

The public, privacy-preserving dashboard for **Millennium**, an open research network for bounded work on the Millennium Prize Problems.

This repository is the whole public coordination surface. It contains the static dashboard, curated starting frontier, local Codex connector, strict contribution contract, merged research summaries, automatic data-only pull-request gate, and aggregate statistics. No maintained application server is required.

Raw Codex workspaces, provider events, commands, paths, and quota telemetry stay under the contributor's gitignored `.millennium/private/` directory. Only one reconstructed, allowlisted JSON record can be proposed for publication after a run; credentials are forbidden and screened for known formats, but this is not a formal data-loss-prevention guarantee for arbitrary model prose.

After pairing, the connector reads the authenticated local Codex model catalog and exposes only safe model IDs, display names, descriptions, default markers, and supported reasoning levels to the hosted selector. Account data, service tiers, provider events, and the selected model's private run artifacts remain local; model details are not added to public contribution records.

## Connect local Codex

The GitHub Pages site cannot install native software silently. Clone this public repository and install the per-user Windows connector once:

```bash
git clone https://github.com/LittleSeattlers/Millennium-UI.git
cd Millennium-UI
gh auth login
pnpm install
pnpm connector:install
```

The installer verifies Git, GitHub CLI authentication, and the packaged Codex executable, starts the connector in the background, and registers it to start when you sign in to Windows. After setup:

1. Press **Connect to local Codex**, then press **Allow connection** on the local approval page. It returns to Millennium automatically.
2. Pick a problem, route, and shared-frontier task. Review the real five-hour and weekly quota estimate.
3. Press **Start work**. The connector refuses to start with fewer than five safe minutes. Every accepted duration includes a two-minute finalization reserve; Codex writes a resumable result and structured publication proposal early, refreshes them as findings change, and receives a same-turn wrap-up instruction before the absolute limit.
4. At completion or the safe time limit, the connector removes the claim file, reconstructs one canonical contribution record, pushes it to the same PR, and marks it ready. If no valid structured proposal survives, it submits a truthful recovery record with no inferred mathematical claims. A trusted base-branch workflow validates and squash-merges the data without checking out or executing contributor code.

Local attempts accumulate automatically. Public contribution prose is stored as an unreviewed record but is quarantined from executable Codex prompts and task creation until its attempt ID is added to `research/trusted-contributions.v1.json` through a normal reviewed commit. A later connector sync can then read up to ten trusted summaries, claims, failed approaches, limitations, citations, and next actions; trusted successor proposals become frontier tasks and trusted completed records generate verification tasks.

This trust step is deliberate: in a serverless, open, no-approval network, any GitHub account can submit schema-valid prose, so automatically turning every contribution into a future agent instruction would permit prompt injection and research poisoning. GitHub remains the durable result ledger; promotion into executable context is a separate safety decision.

The local approval URL contains only a request ID and SHA-256 challenge. The redeemable verifier is kept briefly in that tab's session storage for the approval round trip, then removed; the paired session remains in memory. The companion binds only to `127.0.0.1`, serves an unframeable approval page, and grants each tab control only over attempts that tab starts. Research-network access is disabled for starts from the hosted page.

GitHub draft PRs provide best-effort, expiring cross-machine claims rather than a perfectly atomic lock. If two contributors race, the lowest PR number wins and the other connector stops before spending Codex quota.

## Run locally

Requires Node.js 22+ and pnpm 11.

```bash
pnpm install
pnpm dev
```

Vite serves the project under `/Millennium-UI/`, matching its GitHub Pages path.

## Validate

```bash
pnpm validate
```

This runs linting, contribution-boundary tests, shared-frontier tests, TypeScript, and the production build.

## Refresh the public statistics

Rebuild aggregate counts from contribution records already merged on `main`:

```bash
pnpm export:stats
```

The GitHub Pages workflow runs this automatically before each deployment. The aggregate snapshot contains counts only; research summaries remain in their separately inspectable contribution records.

## Publication meaning

A public **run** is one schema-valid contribution record merged under `contributions/attempts/`. Its status is `completed`, `interrupted`, `aborted`, or `failed`, and its review status is always initially `unreviewed`. Counts measure durable activity only; they do not imply correctness, novelty, independent review, or progress toward prize eligibility.

The exact contract is documented in [docs/DATA_BOUNDARY.md](docs/DATA_BOUNDARY.md) and machine-readable at [schemas/contribution.v1.schema.json](schemas/contribution.v1.schema.json). Aggregate output remains described by [public/data/dashboard.v1.schema.json](public/data/dashboard.v1.schema.json).

## Deployment

Ready connector PRs are automatically merged only when they add exactly one canonical, schema-valid contribution JSON file. The merge workflow explicitly dispatches the Pages workflow, which rebuilds the aggregate snapshot, validates the project, and deploys `dist/`.

## License

MIT — see [LICENSE](LICENSE).
