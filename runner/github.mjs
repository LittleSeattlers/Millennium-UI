import crypto from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  LEDGER_ROOT,
  PUBLISH_ROOT,
  PRIVATE_ROOT,
  UPSTREAM_CLONE_URL,
  UPSTREAM_REPOSITORY,
} from './constants.mjs';
import { HttpError } from './security.mjs';
import { resolveExecutable, runCapture } from './providers/process.mjs';
import {
  buildClaimRecord,
  claimMarker,
  claimPath,
  contributionPath,
  parseClaimMarker,
  validateContributionRecord,
} from '../scripts/contribution-contract.mjs';

const SYNC_TTL_MS = 60_000;
const COMMAND_TIMEOUT_MS = 120_000;
let commandState = null;
let syncPromise = null;
let lastSyncAt = 0;

export async function ensureGitHubReady() {
  if (commandState) return commandState;
  const [git, gh] = await Promise.all([
    resolveExecutable(process.platform === 'win32' ? 'git.exe' : 'git'),
    resolveExecutable(process.platform === 'win32' ? 'gh.exe' : 'gh'),
  ]);
  if (!git.path) throw new Error('Git is required for the shared Millennium ledger. Install Git, then reconnect.');
  if (!gh.path) throw new Error('GitHub CLI is required for automatic contribution pull requests. Install gh, sign in, then reconnect.');
  await checked(gh.path, ['auth', 'status', '--hostname', 'github.com'], { timeoutMs: 20_000 });
  const account = await ghJson(gh.path, ['api', 'user'], 'GitHub account');
  if (typeof account?.login !== 'string' || !account.login || !Number.isSafeInteger(account.id)) {
    throw new Error('GitHub CLI did not return a usable signed-in account. Run gh auth login, then reconnect.');
  }
  commandState = { git: git.path, gh: gh.path, login: account.login, accountId: account.id };
  return commandState;
}

export async function syncSharedLedger({ force = false } = {}) {
  if (!force && Date.now() - lastSyncAt < SYNC_TTL_MS) return { syncedAt: new Date(lastSyncAt).toISOString() };
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    const commands = await ensureGitHubReady();
    await mkdir(PRIVATE_ROOT, { recursive: true, mode: 0o700 });
    if (!(await exists(path.join(LEDGER_ROOT, '.git')))) {
      if (await exists(LEDGER_ROOT)) {
        const entries = await import('node:fs/promises').then(({ readdir }) => readdir(LEDGER_ROOT));
        if (entries.length > 0) throw new Error('The managed ledger directory is not empty. Remove only .millennium/private/ledger, then reconnect.');
      }
      await checked(commands.git, ['clone', '--filter=blob:none', '--no-tags', '--depth=1', UPSTREAM_CLONE_URL, LEDGER_ROOT]);
    }
    const remote = (await checked(commands.git, ['-C', LEDGER_ROOT, 'remote', 'get-url', 'origin'])).stdout.trim();
    if (!sameRepository(remote, UPSTREAM_CLONE_URL)) throw new Error('The managed ledger points at an unexpected Git repository.');
    const dirty = (await checked(commands.git, ['-C', LEDGER_ROOT, 'status', '--porcelain=v1'])).stdout.trim();
    if (dirty) throw new Error('The managed ledger contains local changes and cannot be refreshed safely.');
    await checked(commands.git, ['-C', LEDGER_ROOT, 'fetch', '--no-tags', '--depth=1', 'origin', 'main']);
    await checked(commands.git, ['-C', LEDGER_ROOT, 'switch', '--detach', 'origin/main']);
    lastSyncAt = Date.now();
    return { syncedAt: new Date(lastSyncAt).toISOString() };
  })().finally(() => { syncPromise = null; });
  return syncPromise;
}

export async function listOpenClaims({ now = Date.now() } = {}) {
  const commands = await ensureGitHubReady();
  const pages = await ghJson(commands.gh, [
    'api', '--method', 'GET', '--paginate', '--slurp',
    `repos/${UPSTREAM_REPOSITORY}/pulls`, '-f', 'state=open', '-F', 'per_page=100',
  ], 'open contribution claims');
  const pullRequests = Array.isArray(pages)
    ? pages.flatMap((page) => Array.isArray(page) ? page : [])
    : [];
  if (!Array.isArray(pullRequests)) return [];
  return pullRequests.flatMap((pullRequest) => {
    const marker = parseClaimMarker(pullRequest.body);
    const expiresAtMs = marker ? Date.parse(marker.expiresAt) : Number.NaN;
    const createdAtMs = Date.parse(pullRequest.created_at ?? '');
    const titleAllowed = pullRequest.draft
      ? String(pullRequest.title ?? '').startsWith('Research claim:')
      : String(pullRequest.title ?? '').startsWith('Research contribution:');
    if (!marker
      || !titleAllowed
      || !/^millennium\/claim-[a-f0-9-]+$/i.test(String(pullRequest.head?.ref ?? ''))
      || !Number.isFinite(expiresAtMs)
      || !Number.isFinite(createdAtMs)
      || expiresAtMs <= now
      || expiresAtMs - createdAtMs > 3 * 60 * 60 * 1_000) return [];
    return [{
      ...marker,
      expiresAtMs,
      number: pullRequest.number,
      url: pullRequest.html_url,
      headRefName: pullRequest.head.ref,
    }];
  });
}

export async function claimResearchTask({ task, problem, problemId, direction, minutes }) {
  const commands = await ensureGitHubReady();
  await syncSharedLedger({ force: true });
  const active = await listOpenClaims();
  if (active.some((claim) => claim.taskId === task.id)) {
    throw new HttpError(
      409,
      'That research task was just claimed by another contributor. Refresh the frontier and choose another task.',
      'research_task_claimed',
    );
  }

  const claimId = `claim-${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + Math.max(30, Math.min(180, Math.ceil(Number(minutes) || 5) + 30)) * 60_000).toISOString();
  const claim = buildClaimRecord({ claimId, task, problem, problemId, direction, expiresAt });
  const branch = `millennium/${claimId}`;
  const directory = within(PUBLISH_ROOT, claimId);
  await mkdir(PUBLISH_ROOT, { recursive: true, mode: 0o700 });
  await rm(directory, { recursive: true, force: true });
  await checked(commands.git, ['clone', '--filter=blob:none', '--no-tags', '--depth=1', UPSTREAM_CLONE_URL, directory]);
  await checked(commands.git, ['-C', directory, 'config', 'user.name', `${commands.login} via Millennium`]);
  await checked(commands.git, ['-C', directory, 'config', 'user.email', `${commands.accountId}+${commands.login}@users.noreply.github.com`]);
  await checked(commands.git, ['-C', directory, 'switch', '-c', branch]);

  const relativeClaimPath = claimPath(claim);
  await writeJsonFile(directory, relativeClaimPath, claim);
  await checked(commands.git, ['-C', directory, 'add', '--', relativeClaimPath]);
  await assertStagedPaths(commands.git, directory, new Set([`A\t${relativeClaimPath}`]));
  await checked(commands.git, ['-C', directory, 'commit', '-m', `Claim research task ${task.id}`]);

  const publishRepository = await ensurePublishRepository(commands);
  await checked(commands.git, ['-C', directory, 'remote', 'add', 'publish', `https://github.com/${publishRepository}.git`]);
  await checked(commands.git, ['-C', directory, 'push', 'publish', `HEAD:refs/heads/${branch}`]);

  const title = `Research claim: ${String(task.title).slice(0, 120)}`;
  const body = [
    claimMarker(claim),
    'This draft pull request is a temporary, expiring task claim created by the local Millennium connector.',
    '',
    `Task: \`${task.id}\``,
    `Claim expires: ${expiresAt}`,
    '',
    'When the bounded Codex run finishes, this branch will remove the claim file, add one canonical contribution JSON file, and mark the pull request ready for data-only validation.',
  ].join('\n');
  const created = await checked(commands.gh, [
    'pr', 'create', '--repo', UPSTREAM_REPOSITORY, '--base', 'main',
    '--head', `${commands.login}:${branch}`, '--draft', '--title', title, '--body', body,
  ]);
  const prUrl = created.stdout.trim().split(/\r?\n/).find((line) => /^https:\/\//.test(line));
  if (!prUrl) throw new Error('GitHub did not return the draft claim pull request URL.');
  const pullRequest = await ghJson(commands.gh, ['pr', 'view', prUrl, '--repo', UPSTREAM_REPOSITORY, '--json', 'number,url'], 'claim pull request');

  const ownClaim = { taskId: task.id, number: pullRequest.number, url: pullRequest.url };
  try {
    let discovered = [];
    let ownVisible = false;
    for (let poll = 0; poll < 4; poll += 1) {
      if (poll > 0) await delay(poll * 300);
      discovered = await listOpenClaims();
      ownVisible = discovered.some((candidate) => Number(candidate?.number) === pullRequest.number);
      if (ownVisible) break;
    }
    if (!ownVisible) {
      throw new HttpError(
        503,
        'GitHub did not confirm the new task claim. Please retry in a moment.',
        'research_claim_unconfirmed',
      );
    }
    const winner = selectClaimWinner(task.id, ownClaim, discovered);
    if (winner?.number !== pullRequest.number) {
      throw new HttpError(
        409,
        'Another contributor won the task claim race. Refresh the frontier and choose another task.',
        'research_task_claimed',
      );
    }
  } catch (error) {
    await checked(commands.gh, ['pr', 'close', String(pullRequest.number), '--repo', UPSTREAM_REPOSITORY]).catch(() => {});
    throw error;
  }

  return {
    claim,
    branch,
    directory,
    publishRepository,
    prNumber: pullRequest.number,
    prUrl: pullRequest.url,
  };
}

export function selectClaimWinner(taskId, ownClaim, discoveredClaims = []) {
  const candidates = new Map();
  for (const candidate of [ownClaim, ...discoveredClaims]) {
    const number = Number(candidate?.number);
    if (candidate?.taskId !== taskId || !Number.isSafeInteger(number) || number < 1) continue;
    candidates.set(number, { ...candidate, number });
  }
  return [...candidates.values()].sort((left, right) => left.number - right.number)[0] ?? null;
}

export async function publishContribution(handle, record) {
  const commands = await ensureGitHubReady();
  validateContributionRecord(record);
  const directory = within(PUBLISH_ROOT, handle?.claim?.claim_id);
  if (path.resolve(handle?.directory ?? '') !== directory || !(await exists(path.join(directory, '.git')))) {
    throw new Error('The private publication workspace is missing; the raw attempt remains local.');
  }
  const relativeClaimPath = claimPath(handle.claim);
  const relativeContributionPath = contributionPath(record);
  await writeJsonFile(directory, relativeContributionPath, record);
  await rm(within(directory, ...relativeClaimPath.split('/')), { force: true });
  await checked(commands.git, ['-C', directory, 'add', '--', relativeClaimPath, relativeContributionPath]);
  const staged = await stagedPaths(commands.git, directory);
  if (staged.size > 0) {
    assertExactPaths(staged, new Set([`A\t${relativeContributionPath}`, `D\t${relativeClaimPath}`]));
    await checked(commands.git, ['-C', directory, 'commit', '-m', `Publish sanitized attempt ${record.attempt_id}`]);
  }
  await checked(commands.git, ['-C', directory, 'push', 'publish', `HEAD:refs/heads/${handle.branch}`]);

  const current = await ghJson(commands.gh, [
    'pr', 'view', String(handle.prNumber), '--repo', UPSTREAM_REPOSITORY, '--json', 'isDraft,mergedAt,url',
  ], 'contribution pull request');
  if (current.mergedAt) return { prNumber: handle.prNumber, prUrl: current.url, path: relativeContributionPath };

  const body = [
    claimMarker(handle.claim),
    `<!-- millennium-contribution:v2 ${record.attempt_id} -->`,
    'This pull request contains one canonical, evidence-bearing research contribution with best-effort credential screening.',
    '',
    `Problem: \`${record.problem}\``,
    `Task: \`${record.research_task.task_id}\``,
    `Status: \`${record.status}\``,
    `Research value: \`${record.value_assessment.outcome}\``,
    '',
    'Raw Codex events, files, commands, local paths, credentials, quota data, and hidden reasoning were not included.',
  ].join('\n');
  await checked(commands.gh, [
    'pr', 'edit', String(handle.prNumber), '--repo', UPSTREAM_REPOSITORY,
    '--title', `Research contribution: ${record.research_task.title.slice(0, 100)}`,
    '--body', body,
  ]);
  if (current.isDraft) await checked(commands.gh, ['pr', 'ready', String(handle.prNumber), '--repo', UPSTREAM_REPOSITORY]);
  return { prNumber: handle.prNumber, prUrl: handle.prUrl, path: relativeContributionPath };
}

export async function cancelClaim(handle) {
  if (!handle?.prNumber) return;
  const commands = await ensureGitHubReady();
  await checked(commands.gh, ['pr', 'close', String(handle.prNumber), '--repo', UPSTREAM_REPOSITORY]).catch(() => {});
}

async function ensurePublishRepository(commands) {
  if (commands.login.toLowerCase() === UPSTREAM_REPOSITORY.split('/')[0].toLowerCase()) return UPSTREAM_REPOSITORY;
  const repository = `${commands.login}/${UPSTREAM_REPOSITORY.split('/')[1]}`;
  const existing = await run(commands.gh, ['repo', 'view', repository, '--json', 'nameWithOwner']);
  if (existing.code !== 0) {
    await checked(commands.gh, ['repo', 'fork', UPSTREAM_REPOSITORY, '--clone=false']);
  }
  const verified = await ghJson(commands.gh, ['repo', 'view', repository, '--json', 'nameWithOwner'], 'publication fork');
  if (String(verified?.nameWithOwner).toLowerCase() !== repository.toLowerCase()) {
    throw new Error('The GitHub publication fork could not be prepared.');
  }
  return repository;
}

async function assertStagedPaths(git, directory, expected) {
  assertExactPaths(await stagedPaths(git, directory), expected);
}

async function stagedPaths(git, directory) {
  const output = await checked(git, ['-C', directory, 'diff', '--cached', '--name-status', '--no-renames']);
  return new Set(output.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => line.replaceAll('\\', '/')));
}

function assertExactPaths(actual, expected) {
  if (actual.size !== expected.size || [...expected].some((entry) => !actual.has(entry))) {
    throw new Error('Refusing to publish: the Git branch contains changes outside the strict contribution envelope.');
  }
}

async function writeJsonFile(root, relativePath, value) {
  const target = within(root, ...relativePath.split('/'));
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(target, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST' || await readFile(target, 'utf8') !== serialized) throw error;
  }
}

async function ghJson(gh, args, label) {
  const result = await checked(gh, args);
  try { return JSON.parse(result.stdout); } catch { throw new Error(`GitHub returned invalid JSON for ${label}.`); }
}

async function checked(executable, args, options = {}) {
  const result = await run(executable, args, options);
  if (result.code !== 0 || result.timedOut || result.overflow) {
    const detail = String(result.stderr || result.stdout || 'command failed').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
    throw new Error(`GitHub coordination failed: ${detail}`);
  }
  return result;
}

function run(executable, args, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return runCapture(executable, args, { timeoutMs, maxBytes: 1024 * 1024 });
}

function within(root, ...segments) {
  const base = path.resolve(root);
  const candidate = path.resolve(base, ...segments);
  const relative = path.relative(base, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Managed publication path escaped its private root.');
  }
  return candidate;
}

async function exists(candidate) {
  try { await access(candidate); return true; } catch { return false; }
}

function sameRepository(left, right) {
  const normalize = (value) => String(value).trim().replace(/^git@github\.com:/i, 'https://github.com/').replace(/\.git$/i, '').toLowerCase();
  return normalize(left) === normalize(right);
}
