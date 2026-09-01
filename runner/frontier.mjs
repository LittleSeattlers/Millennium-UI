import crypto from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  PRIVATE_ROOT,
  PROBLEMS,
  REPO_ROOT,
} from './constants.mjs';
import {
  HttpError,
  requireChoice,
  requireNumber,
  requireString,
} from './security.mjs';

export const RESEARCH_MODES = Object.freeze(['recommended', 'frontier', 'explore', 'verify']);

const TASK_KINDS = new Set([
  'proof',
  'counterexample-search',
  'computation',
  'formalization',
  'review',
  'synthesis',
  'exploration',
]);
const TERMINAL_STATUSES = new Set(['completed', 'interrupted', 'aborted', 'failed']);
const FRONTIER_FILE = path.join(REPO_ROOT, 'research', 'frontier.v1.json');
const LEASES_FILE = path.join(PRIVATE_ROOT, 'frontier-leases.v1.json');
const MAX_LEASE_MINUTES = 180;
let leaseQueue = Promise.resolve();

export async function listResearchFrontier({
  problemId,
  direction,
  safeMinutes = 30,
  attempts = [],
  externalClaims = [],
  now = Date.now(),
  catalogFile = FRONTIER_FILE,
  leasesFile = LEASES_FILE,
} = {}) {
  const selection = validateSelection(problemId, direction);
  const minutes = Math.floor(requireNumber(safeMinutes, 'safeMinutes', { min: 1, max: 120 }));
  const catalog = await loadResearchCatalog(catalogFile);
  const leases = mergeClaims(await readActiveLeases(leasesFile, now), externalClaims, now);
  const attempted = attemptedTaskCounts(attempts);
  const curated = uniqueTasks([
    ...catalog.tasks.filter((task) => task.problemId === selection.problemId && task.direction === selection.direction),
    ...communityTasks(attempts, selection),
  ])
    .map((task) => decorateTask(task, { attempted, leases, now }));
  const verification = verificationTasks(attempts, selection)
    .map((task) => decorateTask(task, { attempted, leases, now }));
  const internalTasks = [...verification, ...curated];
  const recommendation = internalTasks
    .filter((task) => task.status === 'available' && dependenciesReady(task, attempted))
    .sort((left, right) => recommendationScore(right, minutes) - recommendationScore(left, minutes)
      || left.id.localeCompare(right.id))[0] ?? null;
  const tasks = internalTasks.map(publicTask);
  const branches = [...new Set(curated.map((task) => task.branchId))]
    .sort()
    .map((branchId) => {
      const branchTasks = curated.filter((task) => task.branchId === branchId);
      return {
        id: branchId,
        available: branchTasks.filter((task) => task.status === 'available').length,
        leased: branchTasks.filter((task) => task.status === 'leased').length,
        attempted: branchTasks.filter((task) => task.status === 'attempted').length,
      };
    });

  return {
    schemaVersion: 1,
    problemId: selection.problemId,
    direction: selection.direction,
    safeMinutes: minutes,
    recommendedTaskId: recommendation?.id ?? null,
    tasks,
    branches,
    counts: {
      available: tasks.filter((task) => task.status === 'available').length,
      leased: tasks.filter((task) => task.status === 'leased').length,
      attempted: tasks.filter((task) => task.status === 'attempted').length,
      verification: tasks.filter((task) => task.kind === 'review').length,
    },
  };
}

export async function prepareResearchTask({
  mode = 'recommended',
  taskId = null,
  newDirection = null,
  problemId,
  direction,
  safeMinutes = 30,
  attempts = [],
  externalClaims = [],
  now = Date.now(),
  catalogFile = FRONTIER_FILE,
  leasesFile = LEASES_FILE,
} = {}) {
  const selectedMode = requireChoice(mode, RESEARCH_MODES, 'taskMode');
  const selection = validateSelection(problemId, direction);
  const minutes = Math.floor(requireNumber(safeMinutes, 'safeMinutes', { min: 1, max: 120 }));

  if (selectedMode === 'explore') {
    const proposed = requireString(newDirection, 'newDirection', { min: 20, max: 600 })
      .replace(/\s+/g, ' ')
      .trim();
    const digest = crypto.createHash('sha256')
      .update(`${selection.problemId}\n${selection.direction}\n${proposed.toLowerCase()}`, 'utf8')
      .digest('hex')
      .slice(0, 16);
    return {
      id: `${selection.problemId}.${selection.direction}.explore.${digest}`,
      problemId: selection.problemId,
      direction: selection.direction,
      branchId: `explore-${digest}`,
      mode: selectedMode,
      kind: 'exploration',
      title: `Explore: ${truncate(proposed, 96)}`,
      objective: `Investigate this contributor-proposed direction as a distinct branch: ${proposed} First state the smallest falsifiable subclaim, compare it with supplied prior context, and run one check that can produce either reusable evidence or a precise obstruction.`,
      rationale: 'The curated frontier is not exhaustive; new directions enter as explicit, falsifiable branches.',
      successCriteria: 'A checkable advance on the smallest stated subclaim with all assumptions and scope limits explicit.',
      usefulFailureCriteria: 'A reproducible reason the proposed direction fails, duplicates prior work, or requires a sharper prerequisite.',
      verificationMethod: 'Give an independent derivation, exact check, certificate, or clearly scoped reproduction plan.',
      suggestedMinutes: minutes,
      priority: 70,
      dependencies: [],
      sourceAttemptIds: [],
    };
  }

  const internal = await internalFrontier({
    selection,
    safeMinutes: minutes,
    attempts,
    externalClaims,
    now,
    catalogFile,
    leasesFile,
  });
  let task;
  if (taskId) {
    const requestedId = requireString(taskId, 'taskId', { min: 8, max: 180 });
    task = internal.tasks.find((candidate) => candidate.id === requestedId) ?? null;
  } else if (selectedMode === 'recommended') {
    task = internal.recommendation;
  } else {
    task = null;
  }
  if (!task) {
    throw new HttpError(
      409,
      selectedMode === 'recommended'
        ? 'No curated task is currently available. Explore a new direction instead.'
        : 'Choose an available research task.',
      'research_task_unavailable',
    );
  }
  if (selectedMode === 'verify' && task.kind !== 'review') {
    throw new HttpError(400, 'Verify mode requires a verification task.', 'validation');
  }
  if (selectedMode === 'frontier' && task.kind === 'review') {
    throw new HttpError(400, 'Use Verify result for a verification task.', 'validation');
  }
  if (task.status !== 'available') {
    const reason = task.status === 'leased'
      ? 'That task is already leased by another local attempt.'
      : 'That task already has a durable local attempt.';
    throw new HttpError(409, reason, 'research_task_unavailable');
  }
  return {
    ...stripTaskState(task),
    mode: selectedMode,
  };
}

export async function leaseResearchTask(task, ownerId, minutes, {
  now = Date.now(),
  leasesFile = LEASES_FILE,
} = {}) {
  const taskId = requireString(task?.id, 'taskId', { min: 8, max: 180 });
  const owner = requireString(ownerId, 'task lease owner', { min: 8, max: 160 });
  const duration = Math.max(5, Math.min(MAX_LEASE_MINUTES, Math.ceil(Number(minutes) || 5) + 20));
  return withLeaseQueue(async () => {
    const leases = await readLeaseMap(leasesFile);
    const current = leases[taskId];
    if (current?.expiresAtMs > now && current.ownerId !== owner) {
      throw new HttpError(409, 'That task was just leased by another local attempt.', 'research_task_leased');
    }
    const lease = {
      taskId,
      ownerId: owner,
      leasedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + duration * 60_000).toISOString(),
      expiresAtMs: now + duration * 60_000,
    };
    leases[taskId] = lease;
    await writeLeaseMap(leasesFile, leases, now);
    return { taskId, leasedAt: lease.leasedAt, expiresAt: lease.expiresAt };
  });
}

export async function releaseResearchTaskLease(taskId, ownerId, {
  now = Date.now(),
  leasesFile = LEASES_FILE,
} = {}) {
  const id = requireString(taskId, 'taskId', { min: 8, max: 180 });
  const owner = requireString(ownerId, 'task lease owner', { min: 8, max: 160 });
  return withLeaseQueue(async () => {
    const leases = await readLeaseMap(leasesFile);
    if (!leases[id] || leases[id].ownerId !== owner) return false;
    delete leases[id];
    await writeLeaseMap(leasesFile, leases, now);
    return true;
  });
}

async function internalFrontier({
  selection,
  safeMinutes,
  attempts,
  externalClaims,
  now,
  catalogFile,
  leasesFile,
}) {
  const catalog = await loadResearchCatalog(catalogFile);
  const leases = mergeClaims(await readActiveLeases(leasesFile, now), externalClaims, now);
  const attempted = attemptedTaskCounts(attempts);
  const curated = uniqueTasks([
    ...catalog.tasks.filter((task) => task.problemId === selection.problemId && task.direction === selection.direction),
    ...communityTasks(attempts, selection),
  ])
    .map((task) => decorateTask(task, { attempted, leases, now }));
  const verification = verificationTasks(attempts, selection)
    .map((task) => decorateTask(task, { attempted, leases, now }));
  const tasks = [...verification, ...curated];
  const recommendation = tasks
    .filter((task) => task.status === 'available' && dependenciesReady(task, attempted))
    .sort((left, right) => recommendationScore(right, safeMinutes) - recommendationScore(left, safeMinutes)
      || left.id.localeCompare(right.id))[0] ?? null;
  return { tasks, recommendation };
}

async function loadResearchCatalog(catalogFile) {
  let raw;
  try {
    raw = JSON.parse(await readFile(catalogFile, 'utf8'));
  } catch (error) {
    throw new Error(`Research frontier could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw?.schemaVersion !== 1 || !Array.isArray(raw.tasks)) {
    throw new Error('Research frontier schemaVersion 1 with a tasks array is required.');
  }
  const ids = new Set();
  const tasks = raw.tasks.map((task, index) => {
    const normalized = normalizeCatalogTask(task, index);
    if (ids.has(normalized.id)) throw new Error(`Research frontier task ID is duplicated: ${normalized.id}`);
    ids.add(normalized.id);
    return normalized;
  });
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) throw new Error(`Research frontier dependency is missing: ${dependency}`);
    }
  }
  return { schemaVersion: 1, tasks };
}

function normalizeCatalogTask(task, index) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new Error(`Research frontier task ${index} is not an object.`);
  }
  const problemId = requireChoice(task.problemId, Object.keys(PROBLEMS), `tasks[${index}].problemId`);
  const direction = requireChoice(
    task.direction,
    Object.keys(PROBLEMS[problemId].routes),
    `tasks[${index}].direction`,
  );
  const id = requireString(task.id, `tasks[${index}].id`, { min: 8, max: 180 });
  const branchId = requireString(task.branchId, `tasks[${index}].branchId`, { min: 2, max: 120 });
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id) || !/^[a-z0-9][a-z0-9._-]*$/.test(branchId)) {
    throw new Error(`Research frontier task ${id} has an invalid identifier.`);
  }
  const kind = requireString(task.kind, `tasks[${index}].kind`, { min: 3, max: 40 });
  if (!TASK_KINDS.has(kind) || kind === 'exploration') {
    throw new Error(`Research frontier task ${id} has an unsupported kind.`);
  }
  const dependencies = Array.isArray(task.dependencies)
    ? [...new Set(task.dependencies.map((dependency) => requireString(
      dependency,
      `tasks[${index}].dependencies`,
      { min: 8, max: 180 },
    )))]
    : [];
  return {
    id,
    problemId,
    direction,
    branchId,
    kind,
    title: requireString(task.title, `tasks[${index}].title`, { min: 8, max: 160 }),
    objective: requireString(task.objective, `tasks[${index}].objective`, { min: 20, max: 2_000 }),
    rationale: requireString(task.rationale, `tasks[${index}].rationale`, { min: 20, max: 1_000 }),
    successCriteria: requireString(task.successCriteria, `tasks[${index}].successCriteria`, { min: 20, max: 1_000 }),
    usefulFailureCriteria: requireString(task.usefulFailureCriteria, `tasks[${index}].usefulFailureCriteria`, { min: 20, max: 1_000 }),
    verificationMethod: requireString(task.verificationMethod, `tasks[${index}].verificationMethod`, { min: 20, max: 1_000 }),
    suggestedMinutes: Math.floor(requireNumber(
      task.suggestedMinutes,
      `tasks[${index}].suggestedMinutes`,
      { min: 5, max: 120 },
    )),
    priority: Math.floor(requireNumber(task.priority, `tasks[${index}].priority`, { min: 0, max: 100 })),
    dependencies,
    sourceAttemptIds: [],
  };
}

function communityTasks(attempts, selection) {
  const tasks = [];
  for (const attempt of attempts) {
    if (attempt?.problemId !== selection.problemId
      || (attempt?.direction ?? attempt?.routeId) !== selection.direction
      || !TERMINAL_STATUSES.has(attempt?.status)
      || !Array.isArray(attempt.proposedTasks)) continue;
    for (const proposal of attempt.proposedTasks.slice(0, 3)) {
      if (!proposal?.id) continue;
      const relationship = proposal.relationship;
      const parentTaskId = attempt?.researchTask?.taskId ?? attempt?.researchTask?.id ?? null;
      tasks.push({
        id: proposal.id,
        problemId: selection.problemId,
        direction: selection.direction,
        branchId: relationship === 'alternative'
          ? `alternative-${proposal.id.slice(-16)}`
          : attempt?.researchTask?.branchId ?? `community-${proposal.id.slice(-16)}`,
        kind: relationship === 'verification' ? 'review' : relationship === 'child' ? 'synthesis' : 'exploration',
        title: proposal.title,
        objective: proposal.objective,
        rationale: proposal.rationale,
        successCriteria: proposal.success_criteria,
        usefulFailureCriteria: proposal.useful_failure_criteria,
        verificationMethod: proposal.verification_method,
        suggestedMinutes: proposal.suggested_minutes,
        priority: relationship === 'verification' ? 92 : relationship === 'child' ? 82 : 74,
        dependencies: relationship === 'child' && parentTaskId ? [parentTaskId] : [],
        sourceAttemptIds: [...(proposal.sourceAttemptIds ?? [attempt.id ?? attempt.attemptId])],
      });
    }
  }
  return tasks;
}

function uniqueTasks(tasks) {
  const seen = new Set();
  return tasks.filter((task) => {
    if (!task?.id || seen.has(task.id)) return false;
    seen.add(task.id);
    return true;
  });
}

function mergeClaims(localLeases, externalClaims, now) {
  const leases = { ...localLeases };
  for (const claim of Array.isArray(externalClaims) ? externalClaims : []) {
    const taskId = typeof claim?.taskId === 'string' ? claim.taskId : null;
    const expiresAtMs = Number(claim?.expiresAtMs ?? Date.parse(claim?.expiresAt ?? ''));
    if (!taskId || !Number.isFinite(expiresAtMs) || expiresAtMs <= now) continue;
    const current = leases[taskId];
    if (!current || current.expiresAtMs < expiresAtMs) {
      leases[taskId] = { taskId, ownerId: 'github-claim', expiresAtMs, expiresAt: new Date(expiresAtMs).toISOString() };
    }
  }
  return leases;
}

function verificationTasks(attempts, selection) {
  return attempts
    .filter((attempt) => attempt?.problemId === selection.problemId
      && (attempt?.direction ?? attempt?.routeId) === selection.direction
      && attempt?.status === 'completed'
      && attempt?.reviewStatus === 'unreviewed')
    .map((attempt) => {
      const opaque = crypto.createHash('sha256')
        .update(String(attempt.id ?? attempt.attemptId), 'utf8')
        .digest('hex')
        .slice(0, 16);
      return {
        id: `${selection.problemId}.${selection.direction}.verify.${opaque}`,
        problemId: selection.problemId,
        direction: selection.direction,
        branchId: 'independent-verification',
        kind: 'review',
        title: `Independently verify local result ${opaque.slice(0, 8).toUpperCase()}`,
        objective: 'Independently reconstruct and challenge the selected local attempt. Check each explicit claim against its supplied evidence, reproduce any deterministic computation, and record agreement, disagreement, or an exact unresolved dependency.',
        rationale: 'Independent verification is required before a research artifact can gain stronger review status.',
        successCriteria: 'A claim-by-claim review with reproduced evidence and a justified disposition.',
        usefulFailureCriteria: 'A precise irreproducible step, missing artifact, counterexample, or ambiguity requiring revision.',
        verificationMethod: 'Re-derive the claims without relying on the prior author\'s conclusion and rerun deterministic checks from preserved inputs.',
        suggestedMinutes: 30,
        priority: 98,
        dependencies: [],
        sourceAttemptIds: [String(attempt.id ?? attempt.attemptId)],
      };
    });
}

function attemptedTaskCounts(attempts) {
  const counts = new Map();
  for (const attempt of attempts) {
    if (attempt?.status !== 'completed') continue;
    const taskId = attempt?.researchTask?.taskId ?? attempt?.researchTask?.id;
    if (typeof taskId !== 'string') continue;
    counts.set(taskId, (counts.get(taskId) ?? 0) + 1);
  }
  return counts;
}

function decorateTask(task, { attempted, leases, now }) {
  const attemptCount = attempted.get(task.id) ?? 0;
  const lease = leases[task.id];
  const status = attemptCount > 0
    ? 'attempted'
    : lease?.expiresAtMs > now
      ? 'leased'
      : 'available';
  return { ...task, status, attemptCount };
}

function dependenciesReady(task, attempted) {
  return task.dependencies.every((dependency) => (attempted.get(dependency) ?? 0) > 0);
}

function recommendationScore(task, safeMinutes) {
  const overBudget = Math.max(0, task.suggestedMinutes - safeMinutes);
  const fit = 24 - Math.abs(task.suggestedMinutes - safeMinutes) * 0.25 - overBudget * 1.5;
  const verificationBonus = task.kind === 'review' ? 12 : 0;
  return task.priority + fit + verificationBonus;
}

function publicTask(task) {
  return {
    id: task.id,
    problemId: task.problemId,
    direction: task.direction,
    branchId: task.branchId,
    kind: task.kind,
    title: task.title,
    objective: task.objective,
    rationale: task.rationale,
    successCriteria: task.successCriteria,
    usefulFailureCriteria: task.usefulFailureCriteria,
    verificationMethod: task.verificationMethod,
    suggestedMinutes: task.suggestedMinutes,
    priority: task.priority,
    dependencies: [...task.dependencies],
    status: task.status,
    attemptCount: task.attemptCount,
  };
}

function stripTaskState(task) {
  const selection = { ...task };
  delete selection.status;
  delete selection.attemptCount;
  return {
    ...selection,
    dependencies: [...selection.dependencies],
    sourceAttemptIds: [...selection.sourceAttemptIds],
  };
}

function validateSelection(problemId, direction) {
  const problem = requireChoice(problemId, Object.keys(PROBLEMS), 'problemId');
  const selectedDirection = requireChoice(direction, Object.keys(PROBLEMS[problem].routes), 'direction');
  return { problemId: problem, direction: selectedDirection };
}

async function readActiveLeases(leasesFile, now) {
  const leases = await readLeaseMap(leasesFile);
  return Object.fromEntries(Object.entries(leases).filter(([, lease]) => lease?.expiresAtMs > now));
}

async function readLeaseMap(leasesFile) {
  try {
    const value = JSON.parse(await readFile(leasesFile, 'utf8'));
    if (value?.schemaVersion !== 1 || !value.leases || typeof value.leases !== 'object') return {};
    return Object.fromEntries(Object.entries(value.leases).filter(([taskId, lease]) => (
      /^[a-z0-9][a-z0-9._-]{7,179}$/.test(taskId)
      && typeof lease?.ownerId === 'string'
      && Number.isFinite(Number(lease?.expiresAtMs))
    )));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeLeaseMap(leasesFile, leases, now) {
  const active = Object.fromEntries(Object.entries(leases).filter(([, lease]) => lease?.expiresAtMs > now));
  await mkdir(path.dirname(leasesFile), { recursive: true, mode: 0o700 });
  const temporary = `${leasesFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const payload = `${JSON.stringify({ schemaVersion: 1, leases: active }, null, 2)}\n`;
  try {
    await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, leasesFile);
  } catch (error) {
    try { await unlink(temporary); } catch { /* nothing to clean up */ }
    throw error;
  }
}

function withLeaseQueue(operation) {
  const result = leaseQueue.then(operation, operation);
  leaseQueue = result.then(() => undefined, () => undefined);
  return result;
}

function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}
