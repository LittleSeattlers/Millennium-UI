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
  MIN_USEFUL_RUN_MINUTES,
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
const ADAPTIVE_SLICE_VERSION = 1;
const ADAPTIVE_SLICE_MINUTES = MIN_USEFUL_RUN_MINUTES;
const ADAPTIVE_SLICE_PREFIX = `auto.slice.v${ADAPTIVE_SLICE_VERSION}.`;
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
  const { curated, verification } = await assembleFrontierTasks({
    selection,
    safeMinutes: minutes,
    attempts,
    externalClaims,
    now,
    catalogFile,
    leasesFile,
  });
  const internalTasks = [...verification, ...curated];
  const recommendation = internalTasks
    .filter((task) => isRunnableTask(task, minutes))
    .sort((left, right) => recommendationScore(right, minutes) - recommendationScore(left, minutes)
      || left.id.localeCompare(right.id))[0] ?? null;
  const tasks = internalTasks.map(publicTask);
  const branches = [...new Set(curated.map((task) => task.branchId))]
    .sort()
    .map((branchId) => {
      const branchTasks = curated.filter((task) => task.branchId === branchId);
      return {
        id: branchId,
        available: branchTasks.filter((task) => isRunnableTask(task, minutes)).length,
        leased: branchTasks.filter((task) => task.status === 'leased').length,
        attempted: branchTasks.filter((task) => task.status === 'attempted').length,
        blocked: branchTasks.filter((task) => task.status === 'blocked').length,
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
      available: internalTasks.filter((task) => isRunnableTask(task, minutes)).length,
      leased: tasks.filter((task) => task.status === 'leased').length,
      attempted: tasks.filter((task) => task.status === 'attempted').length,
      blocked: tasks.filter((task) => task.status === 'blocked').length,
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
    if (minutes < MIN_USEFUL_RUN_MINUTES) {
      throw new HttpError(
        409,
        `Only ${minutes} safe minute${minutes === 1 ? '' : 's'} are available. A useful research run requires at least ${MIN_USEFUL_RUN_MINUTES}; no Codex research run was started.`,
        'insufficient_safe_time',
      );
    }
    const proposed = requireString(newDirection, 'newDirection', { min: 20, max: 600 })
      .replace(/\s+/g, ' ')
      .trim();
    const digest = crypto.createHash('sha256')
      .update(`${selection.problemId}\n${selection.direction}\n${proposed.toLowerCase()}`, 'utf8')
      .digest('hex')
      .slice(0, 16);
    return withValueContract({
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
      budgetBasis: 'available-window',
      parentTaskId: null,
      parentContract: null,
      priority: 70,
      dependencies: [],
      sourceAttemptIds: [],
    });
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
      : task.status === 'blocked'
        ? `That task is waiting on ${task.blockedDependencies.length} unfinished prerequisite${task.blockedDependencies.length === 1 ? '' : 's'}.`
        : 'That task already has a durable local attempt.';
    throw new HttpError(409, reason, 'research_task_unavailable');
  }
  if (!taskFitsAllowance(task, minutes)) {
    throw new HttpError(
      409,
      `This task needs ${task.suggestedMinutes} safe minutes, but only ${minutes} are currently available.`,
      'insufficient_task_time',
    );
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
  const { curated, verification } = await assembleFrontierTasks({
    selection,
    safeMinutes,
    attempts,
    externalClaims,
    now,
    catalogFile,
    leasesFile,
  });
  const tasks = [...verification, ...curated];
  const recommendation = tasks
    .filter((task) => isRunnableTask(task, safeMinutes))
    .sort((left, right) => recommendationScore(right, safeMinutes) - recommendationScore(left, safeMinutes)
      || left.id.localeCompare(right.id))[0] ?? null;
  return { tasks, recommendation };
}

async function assembleFrontierTasks({
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
  const sourceTasks = uniqueTasks([
    ...catalog.tasks.filter((task) => task.problemId === selection.problemId && task.direction === selection.direction),
    ...communityTasks(attempts, selection),
  ]);
  const unlockCounts = countDirectDependents(sourceTasks);
  const baseTasks = sourceTasks.map((task) => decorateTask(
    { ...task, unlockCount: unlockCounts.get(task.id) ?? 0 },
    { attempted, leases, now },
  ));
  const hasRunnableResearchTask = baseTasks.some((task) => (
    task.kind !== 'review' && isRunnableTask(task, safeMinutes)
  ));
  const adaptiveSlices = safeMinutes >= ADAPTIVE_SLICE_MINUTES && !hasRunnableResearchTask
    ? baseTasks
      .filter((task) => task.kind !== 'review'
        && task.status === 'available'
        && task.suggestedMinutes > safeMinutes)
      .map(adaptiveSliceFor)
      .map((task) => decorateTask(task, { attempted, leases, now }))
    : [];
  const curated = uniqueTasks([...adaptiveSlices, ...baseTasks]);
  const verification = verificationTasks(attempts, selection)
    .map((task) => decorateTask(task, { attempted, leases, now }));
  return { curated, verification };
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
  if (id.startsWith(ADAPTIVE_SLICE_PREFIX)) {
    throw new Error(`Research frontier task ${id} uses the reserved adaptive-slice prefix.`);
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
      { min: MIN_USEFUL_RUN_MINUTES, max: 120 },
    )),
    budgetBasis: 'editorial-plan',
    parentTaskId: null,
    parentContract: null,
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
      || !attemptHasResearchValue(attempt)
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
        suggestedMinutes: Math.max(MIN_USEFUL_RUN_MINUTES, proposal.suggested_minutes),
        budgetBasis: 'contributor-plan',
        parentTaskId,
        parentContract: null,
        priority: relationship === 'verification' ? 92 : relationship === 'child' ? 82 : 74,
        dependencies: relationship === 'child' && parentTaskId ? [parentTaskId] : [],
        sourceAttemptIds: [...(proposal.sourceAttemptIds ?? [attempt.id ?? attempt.attemptId])],
      });
    }
  }
  return tasks;
}

function adaptiveSliceFor(parent) {
  const identity = JSON.stringify({
    version: ADAPTIVE_SLICE_VERSION,
    id: parent.id,
    problemId: parent.problemId,
    direction: parent.direction,
    branchId: parent.branchId,
    kind: parent.kind,
    title: parent.title,
    objective: parent.objective,
    rationale: parent.rationale,
    successCriteria: parent.successCriteria,
    usefulFailureCriteria: parent.usefulFailureCriteria,
    verificationMethod: parent.verificationMethod,
    suggestedMinutes: parent.suggestedMinutes,
    priority: parent.priority,
    dependencies: [...parent.dependencies].sort(),
    sourceAttemptIds: [...parent.sourceAttemptIds].sort(),
  });
  const digest = crypto.createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 32);
  return {
    id: `${ADAPTIVE_SLICE_PREFIX}${digest}`,
    problemId: parent.problemId,
    direction: parent.direction,
    branchId: parent.branchId,
    kind: 'formalization',
    title: truncate(`Scope a runnable slice of ${parent.title}`, 160),
    objective: `Treat ${parent.id} as the parent task. Do not attempt or claim that this run completes or weakens the parent. Preserve its statement, assumptions, domains, quantifiers, and success standard. Build a dependency map, isolate the smallest independently decidable prerequisite or failure point, and perform one concrete check on it. A plan or summary alone is not a successful result. End with one to three non-overlapping successor proposals using relationship "child"; if no sound split exists, record the exact indivisibility, coupled dependency, or missing definition.`,
    rationale: `The parent task's ${parent.suggestedMinutes}-minute editorial budget does not fit the current allowance. This one-time preparatory slice creates a reusable foothold instead of truncating, repeatedly rescoping, or pretending to complete the parent.`,
    successCriteria: 'A dependency map, one precisely stated subclaim, one reproducible check with explicit evidence, and one to three child proposals that preserve the parent claim boundary.',
    usefulFailureCriteria: 'An exact ambiguity, coupled dependency, missing theorem, or indivisibility argument showing why a sound smaller task cannot yet be formed, plus the smallest missing information.',
    verificationMethod: 'Compare every derived subclaim with the parent objective and success criteria, check that no assumption, domain, or quantifier was dropped, and independently reproduce the concrete check.',
    suggestedMinutes: ADAPTIVE_SLICE_MINUTES,
    budgetBasis: 'adaptive-slice',
    parentTaskId: parent.id,
    parentContract: {
      id: parent.id,
      title: parent.title,
      kind: parent.kind,
      objective: parent.objective,
      successCriteria: parent.successCriteria,
      usefulFailureCriteria: parent.usefulFailureCriteria,
      verificationMethod: parent.verificationMethod,
      dependencies: [...parent.dependencies],
    },
    parentSuggestedMinutes: parent.suggestedMinutes,
    priority: parent.priority,
    dependencies: [...parent.dependencies],
    sourceAttemptIds: [...parent.sourceAttemptIds],
  };
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
      && TERMINAL_STATUSES.has(attempt?.status)
      && attemptHasResearchValue(attempt)
      && attempt?.researchTask?.kind !== 'review'
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
        budgetBasis: 'verification-plan',
        parentTaskId: attempt.researchTask?.taskId ?? attempt.researchTask?.id ?? null,
        parentContract: null,
        priority: 98,
        dependencies: [],
        sourceAttemptIds: [String(attempt.id ?? attempt.attemptId)],
      };
    });
}

function attemptedTaskCounts(attempts) {
  const counts = new Map();
  for (const attempt of attempts) {
    if (!TERMINAL_STATUSES.has(attempt?.status) || !attemptHasResearchValue(attempt)) continue;
    const taskId = attempt?.researchTask?.taskId ?? attempt?.researchTask?.id;
    if (typeof taskId !== 'string') continue;
    counts.set(taskId, (counts.get(taskId) ?? 0) + 1);
  }
  return counts;
}

function decorateTask(task, { attempted, leases, now }) {
  const attemptCount = attempted.get(task.id) ?? 0;
  const lease = leases[task.id];
  const blockedDependencies = task.dependencies.filter((dependency) => (attempted.get(dependency) ?? 0) === 0);
  const dependenciesSatisfied = blockedDependencies.length === 0;
  const status = attemptCount > 0
    ? 'attempted'
    : lease?.expiresAtMs > now
      ? 'leased'
      : dependenciesSatisfied
        ? 'available'
        : 'blocked';
  return {
    ...withValueContract(task),
    status,
    attemptCount,
    dependenciesSatisfied,
    blockedDependencies,
  };
}

function recommendationScore(task, safeMinutes) {
  const overBudget = Math.max(0, task.suggestedMinutes - safeMinutes);
  const fit = 24 - Math.abs(task.suggestedMinutes - safeMinutes) * 0.25 - overBudget * 1.5;
  const verificationBonus = task.kind === 'review' ? 18 : 0;
  const dependencyUnlockBonus = Math.min(4, Number(task.unlockCount) || 0) * 8;
  const accumulatedContextBonus = Math.min(3, task.sourceAttemptIds?.length ?? 0) * 2;
  const decompositionPenalty = task.budgetBasis === 'adaptive-slice'
    ? Math.max(0, Number(task.parentSuggestedMinutes) - safeMinutes) * 0.5
    : 0;
  return task.priority + fit + verificationBonus + dependencyUnlockBonus
    + accumulatedContextBonus - decompositionPenalty;
}

function taskFitsAllowance(task, safeMinutes) {
  return task.suggestedMinutes <= safeMinutes;
}

function isRunnableTask(task, safeMinutes) {
  return task.status === 'available'
    && task.dependenciesSatisfied !== false
    && task.suggestedMinutes >= MIN_USEFUL_RUN_MINUTES
    && safeMinutes >= MIN_USEFUL_RUN_MINUTES
    && taskFitsAllowance(task, safeMinutes);
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
    budgetBasis: task.budgetBasis,
    parentTaskId: task.parentTaskId,
    parentContract: task.parentContract
      ? { ...task.parentContract, dependencies: [...task.parentContract.dependencies] }
      : null,
    priority: task.priority,
    dependencies: [...task.dependencies],
    dependenciesSatisfied: task.dependenciesSatisfied,
    blockedDependencies: [...task.blockedDependencies],
    status: task.status,
    attemptCount: task.attemptCount,
    unlockCount: task.unlockCount ?? 0,
    valueContract: { ...task.valueContract },
  };
}

function stripTaskState(task) {
  const selection = { ...task };
  delete selection.status;
  delete selection.attemptCount;
  delete selection.dependenciesSatisfied;
  delete selection.blockedDependencies;
  return {
    ...selection,
    dependencies: [...selection.dependencies],
    sourceAttemptIds: [...selection.sourceAttemptIds],
    parentContract: selection.parentContract
      ? { ...selection.parentContract, dependencies: [...selection.parentContract.dependencies] }
      : null,
    valueContract: { ...selection.valueContract },
  };
}

export function attemptHasResearchValue(attempt) {
  if (!attempt || attempt.recordSource === 'shared-contribution-quarantined') return false;
  if (attempt.recordSource === 'shared-contribution-trusted') return true;
  if (attempt.researchValue?.status === 'accepted') return true;
  return attempt.publication?.status === 'submitted'
    && (attempt.publication?.usedStructuredProposal === true
      || attempt.publication?.contributionSource === 'structured-proposal');
}

function withValueContract(task) {
  return {
    ...task,
    valueContract: {
      positiveOutcome: task.successCriteria,
      negativeOutcome: task.usefulFailureCriteria,
      evidenceRequired: task.verificationMethod,
      noveltyRequired: task.sourceAttemptIds?.length
        ? `State exactly what changes, reproduces, or contradicts the ${task.sourceAttemptIds.length} linked prior contribution${task.sourceAttemptIds.length === 1 ? '' : 's'}.`
        : 'Compare the result with the supplied relevant ledger context and state the exact new delta; if no prior record exists, identify it as the branch baseline.',
      publicationRule: 'The ledger accepts only a bounded claim with evidence, a falsifier, an explicit limitation, and a concrete next action or successor task.',
    },
  };
}

function countDirectDependents(tasks) {
  const counts = new Map();
  for (const task of tasks) {
    for (const dependency of task.dependencies ?? []) {
      counts.set(dependency, (counts.get(dependency) ?? 0) + 1);
    }
  }
  return counts;
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
