import crypto from 'node:crypto';
import path from 'node:path';

export const CONTRIBUTION_SCHEMA_VERSION = 1;
export const CLAIM_SCHEMA_VERSION = 1;

export const PROBLEM_IDS = Object.freeze([
  'riemann-hypothesis',
  'p-vs-np',
  'navier-stokes',
  'hodge-conjecture',
  'birch-swinnerton-dyer',
  'yang-mills-mass-gap',
  'poincare-conjecture',
]);

const PROBLEM_SET = new Set(PROBLEM_IDS);
const STATUS_SET = new Set(['completed', 'interrupted', 'aborted', 'failed']);
const MODE_SET = new Set(['recommended', 'frontier', 'explore', 'verify']);
const KIND_SET = new Set(['proof', 'counterexample-search', 'computation', 'formalization', 'review', 'synthesis', 'exploration']);
const RELATIONSHIP_SET = new Set(['child', 'alternative', 'verification']);
const CONFIDENCE_SET = new Set(['conjectural', 'heuristic', 'computational', 'partial-proof', 'rigorous-within-scope']);
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,179}$/;
const SHORT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,39}$/;
const ATTEMPT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{7,179}$/;
const FORBIDDEN_TEXT = [
  /(?:^|\s)[a-z]:[\\/]/i,
  /(?:^|\s)(?:\/home\/|\/users\/|\/root\/)/i,
  /\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|sk-[a-z0-9_-]{20,})\b/i,
  /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/,
  /\b(?:xox[baprs]-[A-Za-z0-9-]{20,}|npm_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,})\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  /\b(?:authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password)\s*[:=]/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
];

export function buildContributionRecord({ attempt, proposal, sanitizedText = identity }) {
  if (!attempt || typeof attempt !== 'object') fail('attempt metadata is required');
  const input = proposal && typeof proposal === 'object' && !Array.isArray(proposal) ? proposal : {};
  const status = STATUS_SET.has(attempt.status) ? attempt.status : 'failed';
  const task = attempt.researchTask ?? {};
  const record = {
    schema_version: CONTRIBUTION_SCHEMA_VERSION,
    attempt_id: identifier(attempt.id ?? attempt.attemptId, 'attempt_id', ATTEMPT_ID_PATTERN),
    problem: choice(attempt.problem ?? attempt.problemSlug, PROBLEM_SET, 'problem'),
    problem_id: identifier(attempt.problemId ?? attempt.problemKey, 'problem_id', SHORT_ID_PATTERN),
    direction: identifier(attempt.direction ?? attempt.routeKey, 'direction'),
    route: text(attempt.route, 'route', 2, 120, sanitizedText),
    status,
    started_at: timestamp(attempt.startedAt ?? attempt.createdAt, 'started_at'),
    finished_at: timestamp(attempt.finishedAt ?? attempt.completedAt ?? new Date().toISOString(), 'finished_at'),
    research_task: {
      task_id: identifier(task.taskId ?? task.id, 'research_task.task_id'),
      branch_id: identifier(task.branchId, 'research_task.branch_id'),
      mode: choice(task.mode, MODE_SET, 'research_task.mode'),
      kind: choice(task.kind, KIND_SET, 'research_task.kind'),
      title: text(task.title, 'research_task.title', 8, 180, sanitizedText),
    },
    summary: text(
      input.summary ?? fallbackSummary(status),
      'summary',
      20,
      4_000,
      sanitizedText,
    ),
    claims: array(input.claims, 12).map((claim, index) => normalizeClaimResult(claim, index, sanitizedText)),
    limitations: textArray(input.limitations, 'limitations', 12, 20, 900, sanitizedText),
    failed_approaches: textArray(input.failed_approaches ?? input.failedApproaches, 'failed_approaches', 12, 20, 900, sanitizedText),
    next_actions: textArray(input.next_actions ?? input.nextActions, 'next_actions', 12, 20, 900, sanitizedText),
    proposed_tasks: array(input.proposed_tasks ?? input.proposedTasks, 3)
      .map((taskProposal, index) => normalizeTaskProposal(taskProposal, index, sanitizedText)),
    citations: array(input.citations, 20).map((citation, index) => normalizeCitation(citation, index, sanitizedText)),
    prior_attempt_ids: uniqueIdentifiers(attempt.parentAttemptIds ?? [], 10, 'prior_attempt_ids'),
    review_status: 'unreviewed',
  };

  if (record.limitations.length === 0) {
    record.limitations.push('This bounded contribution is unreviewed and does not establish the full Millennium problem.');
  }
  return validateContributionRecord(record);
}

export function validateContributionRecord(value) {
  exactObject(value, [
    'schema_version', 'attempt_id', 'problem', 'problem_id', 'direction', 'route', 'status',
    'started_at', 'finished_at', 'research_task', 'summary', 'claims', 'limitations',
    'failed_approaches', 'next_actions', 'proposed_tasks', 'citations', 'prior_attempt_ids',
    'review_status',
  ], 'contribution');
  if (value.schema_version !== CONTRIBUTION_SCHEMA_VERSION) fail('unsupported contribution schema_version');
  identifier(value.attempt_id, 'attempt_id', ATTEMPT_ID_PATTERN);
  choice(value.problem, PROBLEM_SET, 'problem');
  identifier(value.problem_id, 'problem_id', SHORT_ID_PATTERN);
  identifier(value.direction, 'direction');
  canonical(value.route, text(value.route, 'route', 2, 120), 'route');
  choice(value.status, STATUS_SET, 'status');
  canonical(value.started_at, timestamp(value.started_at, 'started_at'), 'started_at');
  canonical(value.finished_at, timestamp(value.finished_at, 'finished_at'), 'finished_at');
  if (Date.parse(value.finished_at) < Date.parse(value.started_at)) fail('finished_at precedes started_at');
  exactObject(value.research_task, ['task_id', 'branch_id', 'mode', 'kind', 'title'], 'research_task');
  identifier(value.research_task.task_id, 'research_task.task_id');
  identifier(value.research_task.branch_id, 'research_task.branch_id');
  choice(value.research_task.mode, MODE_SET, 'research_task.mode');
  choice(value.research_task.kind, KIND_SET, 'research_task.kind');
  canonical(value.research_task.title, text(value.research_task.title, 'research_task.title', 8, 180), 'research_task.title');
  canonical(value.summary, text(value.summary, 'summary', 20, 4_000), 'summary');
  canonical(value.claims, array(value.claims, 12).map((claim, index) => normalizeClaimResult(claim, index)), 'claims');
  canonical(value.limitations, textArray(value.limitations, 'limitations', 12, 20, 900), 'limitations');
  canonical(value.failed_approaches, textArray(value.failed_approaches, 'failed_approaches', 12, 20, 900), 'failed_approaches');
  canonical(value.next_actions, textArray(value.next_actions, 'next_actions', 12, 20, 900), 'next_actions');
  canonical(value.proposed_tasks, array(value.proposed_tasks, 3).map((task, index) => normalizeTaskProposal(task, index)), 'proposed_tasks');
  canonical(value.citations, array(value.citations, 20).map((citation, index) => normalizeCitation(citation, index)), 'citations');
  uniqueIdentifiers(value.prior_attempt_ids, 10, 'prior_attempt_ids');
  if (value.review_status !== 'unreviewed') fail('review_status must remain unreviewed');
  assertSafeText(JSON.stringify(value), 'contribution');
  return value;
}

export function buildClaimRecord({ claimId, task, problem, problemId, direction, expiresAt }) {
  return validateClaimRecord({
    schema_version: CLAIM_SCHEMA_VERSION,
    claim_id: identifier(claimId, 'claim_id'),
    task_id: identifier(task?.id ?? task?.taskId, 'task_id'),
    problem: choice(problem, PROBLEM_SET, 'problem'),
    problem_id: identifier(problemId, 'problem_id', SHORT_ID_PATTERN),
    direction: identifier(direction, 'direction'),
    claimed_at: new Date().toISOString(),
    expires_at: timestamp(expiresAt, 'expires_at'),
  });
}

export function validateClaimRecord(value) {
  exactObject(value, ['schema_version', 'claim_id', 'task_id', 'problem', 'problem_id', 'direction', 'claimed_at', 'expires_at'], 'claim');
  if (value.schema_version !== CLAIM_SCHEMA_VERSION) fail('unsupported claim schema_version');
  identifier(value.claim_id, 'claim_id');
  identifier(value.task_id, 'task_id');
  choice(value.problem, PROBLEM_SET, 'problem');
  identifier(value.problem_id, 'problem_id', SHORT_ID_PATTERN);
  identifier(value.direction, 'direction');
  canonical(value.claimed_at, timestamp(value.claimed_at, 'claimed_at'), 'claimed_at');
  canonical(value.expires_at, timestamp(value.expires_at, 'expires_at'), 'expires_at');
  if (Date.parse(value.expires_at) <= Date.parse(value.claimed_at)) fail('claim expiry must follow its creation');
  if (Date.parse(value.expires_at) - Date.parse(value.claimed_at) > 3 * 60 * 60 * 1_000) fail('claim lifetime exceeds three hours');
  return value;
}

export function contributionPath(record) {
  validateContributionRecord(record);
  const year = record.started_at.slice(0, 4);
  return path.posix.join('contributions', 'attempts', record.problem, year, `${record.attempt_id}.json`);
}

export function claimPath(record) {
  validateClaimRecord(record);
  return path.posix.join('contributions', 'claims', `${record.claim_id}.json`);
}

export function validateContributionPath(relativePath, record) {
  const normalized = String(relativePath).replaceAll('\\', '/');
  if (normalized !== contributionPath(record)) fail('contribution path does not match its identity');
  return normalized;
}

export function parseClaimMarker(body) {
  const match = /<!--\s*millennium-claim:v1\s+([A-Za-z0-9_-]+)\s+([A-Za-z0-9._-]+)\s+([^\s]+)\s*-->/.exec(String(body ?? ''));
  if (!match) return null;
  try {
    return {
      claimId: identifier(match[1], 'claim marker id'),
      taskId: identifier(match[2], 'claim marker task'),
      expiresAt: timestamp(match[3], 'claim marker expiry'),
    };
  } catch {
    return null;
  }
}

export function claimMarker(claim) {
  validateClaimRecord(claim);
  return `<!-- millennium-claim:v1 ${claim.claim_id} ${claim.task_id} ${claim.expires_at} -->`;
}

export function stableProposedTaskId(attemptId, proposal, index) {
  const digest = crypto.createHash('sha256')
    .update(`${attemptId}\n${index}\n${String(proposal?.title ?? '').toLowerCase()}\n${String(proposal?.objective ?? '').toLowerCase()}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `community.${digest}`;
}

function normalizeClaimResult(value, index, sanitize = identity) {
  exactObject(value, ['statement', 'confidence', 'evidence_summary', 'verification_method'], `claims[${index}]`);
  return {
    statement: text(value.statement, `claims[${index}].statement`, 20, 1_200, sanitize),
    confidence: choice(value.confidence, CONFIDENCE_SET, `claims[${index}].confidence`),
    evidence_summary: text(value.evidence_summary, `claims[${index}].evidence_summary`, 20, 1_500, sanitize),
    verification_method: text(value.verification_method, `claims[${index}].verification_method`, 20, 1_500, sanitize),
  };
}

function normalizeTaskProposal(value, index, sanitize = identity) {
  exactObject(value, [
    'title', 'objective', 'rationale', 'success_criteria', 'useful_failure_criteria',
    'verification_method', 'suggested_minutes', 'relationship',
  ], `proposed_tasks[${index}]`);
  return {
    title: text(value.title, `proposed_tasks[${index}].title`, 8, 180, sanitize),
    objective: text(value.objective, `proposed_tasks[${index}].objective`, 20, 2_000, sanitize),
    rationale: text(value.rationale, `proposed_tasks[${index}].rationale`, 20, 1_000, sanitize),
    success_criteria: text(value.success_criteria, `proposed_tasks[${index}].success_criteria`, 20, 1_000, sanitize),
    useful_failure_criteria: text(value.useful_failure_criteria, `proposed_tasks[${index}].useful_failure_criteria`, 20, 1_000, sanitize),
    verification_method: text(value.verification_method, `proposed_tasks[${index}].verification_method`, 20, 1_000, sanitize),
    suggested_minutes: integer(value.suggested_minutes, `proposed_tasks[${index}].suggested_minutes`, 5, 120),
    relationship: choice(value.relationship, RELATIONSHIP_SET, `proposed_tasks[${index}].relationship`),
  };
}

function normalizeCitation(value, index, sanitize = identity) {
  exactObject(value, ['title', 'url'], `citations[${index}]`);
  return {
    title: text(value.title, `citations[${index}].title`, 2, 300, sanitize),
    url: safeUrl(value.url, `citations[${index}].url`),
  };
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const expected = new Set(keys);
  for (const key of Object.keys(value)) if (!expected.has(key)) fail(`${label} contains unsupported field ${key}`);
  for (const key of keys) if (!(key in value)) fail(`${label} is missing ${key}`);
}

function canonical(value, normalized, label) {
  if (JSON.stringify(value) !== JSON.stringify(normalized)) fail(`${label} is not canonical`);
  return value;
}

function textArray(value, label, maxItems, min, max, sanitize = identity) {
  return array(value, maxItems).map((item, index) => text(item, `${label}[${index}]`, min, max, sanitize));
}

function array(value, maxItems) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) fail(`array must contain at most ${maxItems} items`);
  return value;
}

function uniqueIdentifiers(value, maxItems, label) {
  const values = array(value, maxItems).map((item, index) => identifier(item, `${label}[${index}]`, ATTEMPT_ID_PATTERN));
  if (new Set(values).size !== values.length) fail(`${label} contains duplicates`);
  return values;
}

function identifier(value, label, pattern = ID_PATTERN) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} is invalid`);
  return value;
}

function text(value, label, min, max, sanitize = identity) {
  if (typeof value !== 'string') fail(`${label} must be text`);
  const output = [...String(sanitize(value))]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join('')
    .trim();
  if (output.length < min || output.length > max) fail(`${label} must contain ${min}-${max} characters`);
  assertSafeText(output, label);
  return output;
}

function assertSafeText(value, label) {
  if (FORBIDDEN_TEXT.some((pattern) => pattern.test(String(value)))) fail(`${label} contains private or credential-like text`);
}

function choice(value, choices, label) {
  if (!choices.has(value)) fail(`${label} is unsupported`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail(`${label} must be an ISO-compatible timestamp`);
  return new Date(value).toISOString();
}

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} must be an integer from ${min} to ${max}`);
  return value;
}

function safeUrl(value, label) {
  if (typeof value !== 'string' || value.length > 2_000) fail(`${label} is invalid`);
  let url;
  try { url = new URL(value); } catch { fail(`${label} is invalid`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail(`${label} is not a public HTTP URL`);
  assertSafeText(url.toString(), label);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const ipv4 = parseIpv4(hostname);
  const privateName = hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.lan')
    || (!ipv4 && !hostname.includes('.'));
  if (privateName || hostname.includes(':') || (ipv4 && !isPublicIpv4(ipv4))) {
    fail(`${label} points to a private host`);
  }
  url.search = '';
  url.hash = '';
  if (url.pathname.length > 600) fail(`${label} path is too long`);
  return url.toString();
}

function parseIpv4(hostname) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return null;
  const octets = hostname.split('.').map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function isPublicIpv4([first, second]) {
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && (second === 0 || second === 168)) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  return true;
}

function fallbackSummary(status) {
  return status === 'completed'
    ? 'The bounded Codex run finished, but it did not leave a valid structured public summary; its raw workspace remains private.'
    : 'The bounded Codex run stopped before it left a valid structured public summary; its raw workspace remains private.';
}

function identity(value) { return value; }

function fail(message) {
  throw new Error(`Contribution contract rejected: ${message}`);
}
