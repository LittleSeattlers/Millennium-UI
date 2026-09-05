import crypto from 'node:crypto';
import { constants as FS_CONSTANTS } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  ATTEMPTS_ROOT,
  MAX_PROVIDER_LINE_BYTES,
  PRIVATE_ROOT,
  PROBLEMS,
  REPO_ROOT,
  RUNNER_VERSION,
} from './constants.mjs';
import { deriveBurnObservations } from './quota.mjs';
import {
  assertIdentifier,
  requireString,
  resolveWithin,
  sanitizePublicText,
} from './security.mjs';
import { buildResearchBrief, buildResearchPrompt } from './prompt.mjs';
import { loadSharedContributionRecords } from './knowledge.mjs';

const PRIVATE_RUNS_ROOT = path.join(PRIVATE_ROOT, 'runs');
const PRIVATE_QUOTA_ROOT = path.join(PRIVATE_ROOT, 'quota');
const QUOTA_SNAPSHOTS_FILE = path.join(PRIVATE_QUOTA_ROOT, 'meter-snapshots.jsonl');
const MAX_PRIOR_CONTEXT_CHARS = 20_000;
const MAX_PRIOR_ATTEMPTS = 10;
const MAX_EVENT_REPLAY = 5_000;
const MAX_ARTIFACT_FILES = 1_000;
const MAX_ARTIFACT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_SHARED_ATTEMPTS = 10_000;
const MAX_SHARED_MANIFEST_BYTES = 256 * 1024;
const RUNNING_STATES = new Set(['planned', 'starting', 'running', 'checkpointing', 'stopping']);
const operationQueues = new Map();
const PUBLIC_PATH_REPLACEMENTS = [
  [literalPattern(PRIVATE_ROOT), '$PRIVATE'],
  [literalPattern(ATTEMPTS_ROOT), '$ATTEMPTS'],
  [literalPattern(REPO_ROOT), '$REPOSITORY'],
];

export async function initStorage() {
  await safeMkdirTree(REPO_ROOT, ATTEMPTS_ROOT, 0o755);
  await safeMkdirTree(REPO_ROOT, PRIVATE_RUNS_ROOT, 0o700);
  await safeMkdirTree(REPO_ROOT, PRIVATE_QUOTA_ROOT, 0o700);
  await ensureAppendFile(PRIVATE_ROOT, QUOTA_SNAPSHOTS_FILE, 0o600);
  return {
    attemptsRoot: ATTEMPTS_ROOT,
    privateRoot: PRIVATE_ROOT,
    quotaSnapshotsFile: QUOTA_SNAPSHOTS_FILE,
  };
}

export async function saveQuotaSnapshot(snapshot) {
  await initStorage();
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('A quota snapshot object is required.');
  }
  if (snapshot.provider !== 'codex') throw new Error('Quota snapshot provider is invalid.');
  if (!Array.isArray(snapshot.windows) || snapshot.windows.length === 0) {
    throw new Error('Quota snapshot must contain at least one active window.');
  }
  const capturedAt = new Date(snapshot.capturedAt ?? Date.now());
  if (!Number.isFinite(capturedAt.getTime())) throw new Error('Quota snapshot timestamp is invalid.');
  const stored = safeSerializable({
    ...snapshot,
    capturedAt: capturedAt.toISOString(),
    storageId: `quota-${crypto.randomUUID()}`,
    storedAt: new Date().toISOString(),
  });
  await queued('quota-snapshots', async () => {
    await durableAppend(PRIVATE_ROOT, QUOTA_SNAPSHOTS_FILE, `${JSON.stringify(stored)}\n`, 0o600);
  });
  return stored;
}

export async function loadQuotaSnapshots(provider = null, { limit = 5_000 } = {}) {
  await initStorage();
  if (provider !== null && provider !== 'codex') throw new Error('Quota provider is invalid.');
  const records = await readJsonLines(PRIVATE_ROOT, QUOTA_SNAPSHOTS_FILE);
  return records
    .filter((record) => !provider || record.provider === provider)
    .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt))
    .slice(-Math.max(1, Math.min(20_000, Number(limit) || 5_000)));
}

export async function latestQuotaSnapshot(provider) {
  const snapshots = await loadQuotaSnapshots(provider, { limit: 1 });
  return snapshots.at(-1) ?? null;
}

export async function loadBurnObservations(provider = null) {
  const snapshots = await loadQuotaSnapshots(provider);
  return deriveBurnObservations(snapshots).filter((observation) => !provider || observation.provider === provider);
}

export async function createAttemptRecord(config = {}) {
  await initStorage();
  const problem = resolveProblem(config.problem);
  const route = resolveRoute(problem, config.direction ?? config.route);
  const objective = requireString(clean(config.objective, 2_000), 'objective', { min: 20, max: 2_000 });
  const now = new Date();
  const startedAt = now.toISOString();
  const attemptId = `${problem.canonical}-${startedAt.slice(0, 10)}-${crypto.randomUUID()}`;
  assertIdentifier(attemptId, 'attempt id');
  const year = startedAt.slice(0, 4);
  const relativePublicDir = path.posix.join(problem.canonical, year, attemptId);
  const publicDirectory = resolveWithin(ATTEMPTS_ROOT, problem.canonical, year, attemptId);
  const privateDirectory = resolveWithin(PRIVATE_RUNS_ROOT, attemptId);
  const requestedMinutes = boundedInteger(config.requestedMinutes, 1, 10_080, 5);
  const checkpointMinutes = boundedInteger(config.checkpointMinutes, 1, requestedMinutes, Math.min(5, requestedMinutes));
  if (config.provider !== 'codex') throw new Error('Only the Codex provider is supported.');
  const provider = 'codex';
  const model = clean(config.model || 'provider-default', 160);
  const researchTask = normalizeResearchTask(config.researchTask);
  const priorIds = normalizeAttemptIds([
    ...(config.parentAttemptIds ?? config.priorArtifactIds ?? []),
    ...(researchTask?.sourceAttemptIds ?? []),
  ]);
  const priorContext = config.priorContext ?? await loadPriorContext(problem.canonical);
  const consultedIds = normalizeAttemptIds([
    ...priorIds,
    ...(priorContext?.attempts ?? []).map((attempt) => attempt.attemptId ?? attempt.attempt_id),
  ].filter(Boolean));
  const manifest = {
    schema_version: 1,
    attempt_id: attemptId,
    parent_attempt_ids: priorIds,
    supersedes: normalizeAttemptIds(config.supersedes ?? []),
    problem: problem.canonical,
    route: route.protocolRoute,
    target_direction: clean(config.direction || route.key, 80),
    objective,
    claim_scope: clean(config.claimScope || 'bounded-research-objective', 120),
    research_task: researchTask
      ? {
        task_id: researchTask.taskId,
        branch_id: researchTask.branchId,
        mode: researchTask.mode,
        kind: researchTask.kind,
        title: researchTask.title,
        source_attempt_ids: [...researchTask.sourceAttemptIds],
      }
      : null,
    artifact_state: 'planned',
    started_at: startedAt,
    finished_at: null,
    contributor: clean(config.contributor || 'local-contributor', 160),
    agent: {
      provider,
      interface: clean(config.interface || (provider === 'codex' ? 'codex-app-server' : 'claude-cli'), 80),
      model,
      configuration: clean(config.configuration || configurationLabel(config), 300),
      adapter_version: clean(config.adapterVersion || RUNNER_VERSION, 80),
    },
    budget: {
      requested_minutes: requestedMinutes,
      completed_minutes: 0,
      quota_profile: clean(config.quotaProfile || `private-${provider}-meter-snapshot`, 160),
    },
    provenance: {
      repository_revision: clean(config.repositoryRevision || 'unavailable-at-start', 160),
      environment_manifest: 'evidence/environment.json',
      prior_artifacts_consulted: consultedIds,
    },
    result: {
      disposition: 'in-progress',
      summary: 'This bounded attempt has not produced a conclusion yet.',
      limitations: 'The attempt is unreviewed and may stop at any checkpoint.',
    },
    artifacts: [],
    review_status: 'unreviewed',
  };

  const paths = attemptPaths({ attemptId, relativePublicDir });
  const state = {
    version: 1,
    attemptId,
    problemKey: problem.key,
    routeKey: route.key,
    relativePublicDir,
    status: 'planned',
    artifactState: 'planned',
    startedAt,
    finishedAt: null,
    updatedAt: startedAt,
    lastEventSequence: 1,
    checkpoints: [],
    problemName: clean(config.problemName || problem.name, 160),
    problemId: clean(config.problemId || problem.key, 40),
    direction: clean(config.direction || route.key, 80),
    routeLabel: clean(config.directionLabel || route.label, 160),
    provider,
    riskMode: clean(config.riskMode || 'balanced', 40),
    keepPercent: Number.isFinite(Number(config.keepPercent)) ? Number(config.keepPercent) : 10,
    requestedMinutes,
    allowedMinutes: boundedInteger(config.allowedMinutes, 1, requestedMinutes, requestedMinutes),
    effort: clean(config.effort || 'default', 40),
    networkAccess: config.networkAccess === true || config.networkEnabled === true,
    researchTask,
    priorContext,
    researchValue: { status: 'pending' },
    manifest,
    runtime: {},
  };

  return queued(`attempt:${attemptId}`, async () => {
    await safeMkdirTree(ATTEMPTS_ROOT, path.join(publicDirectory, 'evidence'), 0o755);
    await safeMkdirTree(ATTEMPTS_ROOT, path.join(publicDirectory, 'code'), 0o755);
    await safeMkdirTree(ATTEMPTS_ROOT, path.join(publicDirectory, 'reviews'), 0o755);
    await safeMkdirTree(PRIVATE_RUNS_ROOT, privateDirectory, 0o700);

    const promptConfig = {
      ...config,
      attemptId,
      problem: problem.key,
      route: route.key,
      objective,
      requestedMinutes,
      checkpointMinutes: config.quotaEstimate?.checkpointMinutes ?? checkpointMinutes,
      priorContext,
    };
    const environment = {
      schema_version: 1,
      captured_at: startedAt,
      platform: process.platform,
      architecture: process.arch,
      node_version: process.version,
      runner_version: RUNNER_VERSION,
      provider,
      interface: manifest.agent.interface,
      model,
      repository_revision: manifest.provenance.repository_revision,
      note: 'This public manifest intentionally excludes usernames, absolute paths, credentials, account identifiers, and raw quota history.',
    };
    const createdEvent = sanitizeEvent(attemptId, {
      sequence: 1,
      timestamp: startedAt,
      type: 'attempt.created',
      message: `Created a bounded ${problem.name} attempt using the ${route.label} route.`,
    });
    const summary = renderSummary(manifest);
    const reviewReadme = '# Reviews\n\nNo independent review has been recorded. Add immutable review records here; do not overwrite earlier reviews.\n';

    await atomicWriteFile(ATTEMPTS_ROOT, paths.environmentFile, `${JSON.stringify(environment, null, 2)}\n`, 0o644);
    await atomicWriteFile(ATTEMPTS_ROOT, paths.claimsFile, '', 0o644);
    await atomicWriteFile(ATTEMPTS_ROOT, paths.researchBriefFile, buildResearchBrief(promptConfig), 0o644);
    await atomicWriteFile(ATTEMPTS_ROOT, paths.summaryFile, summary, 0o644);
    await atomicWriteFile(ATTEMPTS_ROOT, paths.reviewsReadmeFile, reviewReadme, 0o644);
    await atomicWriteFile(ATTEMPTS_ROOT, paths.eventsFile, `${JSON.stringify(createdEvent)}\n`, 0o644);
    manifest.artifacts = await collectArtifacts(publicDirectory);
    await atomicWriteFile(ATTEMPTS_ROOT, paths.manifestFile, renderManifestYaml(manifest), 0o644);

    const privateRequest = safeSerializable({
      ...config,
      attemptId,
      problem: problem.key,
      canonicalProblem: problem.canonical,
      route: route.key,
      protocolRoute: route.protocolRoute,
      objective,
      requestedMinutes,
      checkpointMinutes: promptConfig.checkpointMinutes,
      providerPrompt: buildResearchPrompt(promptConfig),
      createdAt: startedAt,
    });
    await atomicWriteJson(PRIVATE_ROOT, paths.requestFile, privateRequest, 0o600);
    await atomicWriteFile(PRIVATE_ROOT, paths.rawEventsFile, '', 0o600);
    await atomicWriteJson(PRIVATE_ROOT, paths.stateFile, state, 0o600);
    return runtimeView(state);
  });
}

export async function appendRawEvent(attemptId, line) {
  const record = await loadInternalAttempt(attemptId);
  const raw = normalizeRawRecord(line);
  return queued(`raw:${attemptId}`, async () => {
    await durableAppend(PRIVATE_ROOT, record.paths.rawEventsFile, `${JSON.stringify(raw)}\n`, 0o600);
    return raw;
  });
}

export async function appendPublicEvent(attemptId, event) {
  return queued(`attempt:${attemptId}`, async () => {
    const record = await loadInternalAttempt(attemptId);
    return appendPublicEventUnlocked(record, event);
  });
}

export async function readEvents(attemptId, after = 0, { limit = 1_000 } = {}) {
  const record = await loadInternalAttempt(attemptId);
  const cursor = Math.max(0, Math.floor(Number(after) || 0));
  const cappedLimit = Math.max(1, Math.min(MAX_EVENT_REPLAY, Math.floor(Number(limit) || 1_000)));
  const events = await readJsonLines(ATTEMPTS_ROOT, record.paths.eventsFile);
  return events.filter((event) => Number(event.sequence) > cursor).slice(0, cappedLimit);
}

export async function getAttempt(attemptId) {
  try {
    const record = await loadInternalAttempt(attemptId);
    return publicView(record.state);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function getAttemptPaths(attemptId) {
  const record = await loadInternalAttempt(attemptId);
  return { ...record.paths };
}

export async function getAttemptPublicationState(attemptId) {
  const record = await loadInternalAttempt(attemptId);
  return {
    publication: record.state.publication ? safeSerializable(record.state.publication) : null,
    publicationHandle: record.state.publicationHandle ? safeSerializable(record.state.publicationHandle) : null,
  };
}

export async function listAttempts({ problem = null, limit = 200 } = {}) {
  await initStorage();
  const canonicalProblem = problem ? resolveProblem(problem).canonical : null;
  const entries = await readdir(PRIVATE_RUNS_ROOT, { withFileTypes: true });
  const attempts = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      const record = await loadInternalAttempt(entry.name);
      if (!canonicalProblem || record.state.manifest.problem === canonicalProblem) attempts.push(publicView(record.state));
    } catch {
      // A malformed private record is ignored here and remains available for manual recovery.
    }
  }
  return attempts
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, Math.max(1, Math.min(2_000, Number(limit) || 200)));
}

export async function listResearchRecords({ problem = null, limit = 2_000 } = {}) {
  const canonicalProblem = problem ? resolveProblem(problem).canonical : null;
  const [local, shared, contributions] = await Promise.all([
    listAttempts({ problem: canonicalProblem, limit: MAX_SHARED_ATTEMPTS }),
    scanSharedAttemptRecords({ problem: canonicalProblem }),
    loadSharedContributionRecords({ problem: canonicalProblem, limit: MAX_SHARED_ATTEMPTS }),
  ]);
  const records = new Map([
    ...shared.map((attempt) => [attempt.attemptId, attempt]),
    ...contributions.map((attempt) => [attempt.attemptId, attempt]),
  ]);
  for (const attempt of local) records.set(attempt.attemptId, { ...attempt, recordSource: 'local' });
  return [...records.values()]
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, Math.max(1, Math.min(MAX_SHARED_ATTEMPTS, Number(limit) || 2_000)));
}

export async function updateAttemptState(attemptId, patch = {}) {
  return queued(`attempt:${attemptId}`, async () => {
    const record = await loadInternalAttempt(attemptId);
    const now = new Date().toISOString();
    const safePatch = safeSerializable(patch);
    const protectedKeys = new Set(['attemptId', 'relativePublicDir', 'manifest', 'version', 'lastEventSequence', 'checkpoints']);
    for (const [key, value] of Object.entries(safePatch)) {
      if (!protectedKeys.has(key) && !['summary', 'limitations', 'disposition', 'summaryMarkdown', 'artifactState'].includes(key)) {
        record.state[key] = value;
      }
    }
    if (safePatch.status) record.state.status = clean(safePatch.status, 80);
    record.state.artifactState = normalizeArtifactState(safePatch.artifactState ?? safePatch.status ?? record.state.artifactState);
    record.state.updatedAt = now;
    syncManifestFromPatch(record.state, safePatch);
    if (safePatch.summaryMarkdown) {
      await atomicWriteFile(ATTEMPTS_ROOT, record.paths.summaryFile, publicText(safePatch.summaryMarkdown), 0o644);
      record.state.manifest.artifacts = await collectArtifacts(record.paths.publicDirectory);
    }
    await atomicWriteFile(ATTEMPTS_ROOT, record.paths.manifestFile, renderManifestYaml(record.state.manifest), 0o644);
    await atomicWriteJson(PRIVATE_ROOT, record.paths.stateFile, record.state, 0o600);
    return publicView(record.state);
  });
}

export async function checkpointAttempt(attemptId, details = {}) {
  if (typeof details === 'string') details = { reason: details, note: `Checkpoint recorded: ${details}.` };
  return queued(`attempt:${attemptId}`, async () => {
    const record = await loadInternalAttempt(attemptId);
    const now = new Date().toISOString();
    const event = await appendPublicEventUnlocked(record, {
      timestamp: now,
      type: 'attempt.checkpointed',
      message: clean(details.message || details.note || 'Durable checkpoint recorded.', 2_000),
      reason: clean(details.reason || 'scheduled', 120),
    }, { persistState: false });
    if (details.summaryMarkdown) {
      await atomicWriteFile(ATTEMPTS_ROOT, record.paths.summaryFile, publicText(details.summaryMarkdown), 0o644);
    }
    record.state.artifactState = 'checkpointed';
    record.state.updatedAt = now;
    record.state.lastEventSequence = event.sequence;
    record.state.checkpoints.push({
      sequence: event.sequence,
      capturedAt: now,
      reason: clean(details.reason || 'scheduled', 120),
      note: clean(details.note || details.message || 'Durable checkpoint recorded.', 2_000),
    });
    syncManifestFromPatch(record.state, details);
    record.state.manifest.artifact_state = 'checkpointed';
    record.state.manifest.artifacts = await collectArtifacts(record.paths.publicDirectory);
    await atomicWriteFile(ATTEMPTS_ROOT, record.paths.manifestFile, renderManifestYaml(record.state.manifest), 0o644);
    await atomicWriteJson(PRIVATE_ROOT, record.paths.stateFile, record.state, 0o600);
    return publicView(record.state);
  });
}

export async function finalizeAttempt(attemptId, outcome = {}) {
  return queued(`attempt:${attemptId}`, async () => {
    const record = await loadInternalAttempt(attemptId);
    if (record.state.finishedAt && !outcome.force) return publicView(record.state);
    const finishedAt = new Date(outcome.finishedAt ?? Date.now());
    if (!Number.isFinite(finishedAt.getTime())) throw new Error('Attempt finish timestamp is invalid.');
    const status = normalizeFinalStatus(outcome.status);
    const artifactState = status === 'completed' ? 'completed' : 'aborted';
    let persistedResult = '';
    try {
      persistedResult = await safeReadFile(ATTEMPTS_ROOT, resolveWithin(record.paths.codeDirectory, 'RESULT.md'), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const fallbackSummary = outcome.error
      ? `The provider run ended with an error: ${clean(outcome.error, 1_000)}`
      : status === 'completed'
        ? 'The provider completed its bounded slice. Inspect the persisted artifacts for the research result.'
        : 'The bounded attempt stopped before normal completion; partial files were preserved.';
    const summary = clean(outcome.summary || persistedResult || fallbackSummary, 9_500);
    const limitations = clean(outcome.limitations || defaultLimitations(status), 9_500);
    const disposition = clean(outcome.disposition || (status === 'completed' ? 'bounded-attempt-completed' : 'interrupted'), 120);
    const event = await appendPublicEventUnlocked(record, {
      timestamp: finishedAt.toISOString(),
      type: status === 'completed' ? 'attempt.completed' : 'attempt.stopped',
      status,
      disposition,
      message: status === 'completed'
        ? 'The bounded Codex run completed and its local artifacts were preserved.'
        : 'The bounded Codex run stopped and its partial local artifacts were preserved.',
    }, { persistState: false });

    record.state.status = status;
    record.state.artifactState = artifactState;
    record.state.finishedAt = finishedAt.toISOString();
    record.state.updatedAt = finishedAt.toISOString();
    record.state.lastEventSequence = event.sequence;
    record.state.runtime = {
      ...record.state.runtime,
      completion: safeSerializable({
        status,
        error: outcome.error ?? null,
        usage: outcome.usage ?? null,
        finishedAt: finishedAt.toISOString(),
      }),
    };
    record.state.manifest.artifact_state = artifactState;
    record.state.manifest.finished_at = finishedAt.toISOString();
    record.state.manifest.budget.completed_minutes = boundedInteger(
      outcome.completedMinutes,
      0,
      10_080,
      Math.max(0, Math.ceil((finishedAt.getTime() - Date.parse(record.state.startedAt)) / 60_000)),
    );
    record.state.manifest.result = { disposition, summary, limitations };
    if (outcome.model) record.state.manifest.agent.model = clean(outcome.model, 160);
    if (outcome.reviewStatus) record.state.manifest.review_status = clean(outcome.reviewStatus, 80);

    const summaryMarkdown = outcome.summaryMarkdown
      ? publicText(outcome.summaryMarkdown)
      : renderSummary(record.state.manifest);
    await atomicWriteFile(ATTEMPTS_ROOT, record.paths.summaryFile, summaryMarkdown, 0o644);
    record.state.manifest.artifacts = await collectArtifacts(record.paths.publicDirectory);
    await atomicWriteFile(ATTEMPTS_ROOT, record.paths.manifestFile, renderManifestYaml(record.state.manifest), 0o644);
    await atomicWriteJson(PRIVATE_ROOT, record.paths.stateFile, record.state, 0o600);
    return publicView(record.state);
  });
}

export async function markInterruptedOnRecovery() {
  const attempts = await listAttempts({ limit: 2_000 });
  const recovered = [];
  for (const attempt of attempts) {
    if (!RUNNING_STATES.has(attempt.status)) continue;
    const finalized = await finalizeAttempt(attempt.attemptId, {
      status: 'interrupted',
      disposition: 'runner-stopped',
      summary: 'The local runner stopped before this bounded attempt reported completion.',
      limitations: 'Files and the last durable event are preserved. Inspect the checkpoint before branching or resuming; no mathematical conclusion is implied.',
    });
    recovered.push(finalized);
  }
  return recovered;
}

export async function loadPriorContext(problem, {
  limit = MAX_PRIOR_ATTEMPTS,
  maxChars = MAX_PRIOR_CONTEXT_CHARS,
  excludeAttemptId = null,
  includeAttemptIds = [],
  direction = null,
  taskId = null,
  branchId = null,
} = {}) {
  const canonical = resolveProblem(problem).canonical;
  const attempts = await listResearchRecords({ problem: canonical, limit: 2_000 });
  const preferred = new Map(normalizeAttemptIds(includeAttemptIds).map((attemptId, index) => [attemptId, index]));
  const ranked = attempts
    .filter((attempt) => attempt.attemptId !== excludeAttemptId
      && attempt.recordSource !== 'shared-contribution-quarantined')
    .sort((left, right) => {
      const leftPreferred = preferred.has(left.attemptId) ? preferred.get(left.attemptId) : Number.MAX_SAFE_INTEGER;
      const rightPreferred = preferred.has(right.attemptId) ? preferred.get(right.attemptId) : Number.MAX_SAFE_INTEGER;
      if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
      const taskDelta = Number(attemptTaskId(right) === taskId) - Number(attemptTaskId(left) === taskId);
      if (taskId && taskDelta) return taskDelta;
      const branchDelta = Number(attemptBranchId(right) === branchId) - Number(attemptBranchId(left) === branchId);
      if (branchId && branchDelta) return branchDelta;
      const directionDelta = Number((right.direction ?? right.routeId) === direction)
        - Number((left.direction ?? left.routeId) === direction);
      if (direction && directionDelta) return directionDelta;
      const reviewDelta = reviewPriority(right.reviewStatus) - reviewPriority(left.reviewStatus);
      return reviewDelta || Date.parse(right.startedAt) - Date.parse(left.startedAt);
    });
  const selected = [];
  let remaining = Math.max(1_000, Math.min(40_000, Number(maxChars) || MAX_PRIOR_CONTEXT_CHARS));
  for (const attempt of ranked.slice(0, Math.max(1, Math.min(20, Number(limit) || MAX_PRIOR_ATTEMPTS)))) {
    if (remaining <= 0) break;
    let summary;
    if (attempt.recordSource === 'shared-contribution-trusted') {
      summary = [
        attempt.summary,
        ...(attempt.valueAssessment ? [
          `Research value (${attempt.valueAssessment.outcome}): ${attempt.valueAssessment.novelty}`,
          `Evidence: ${attempt.valueAssessment.evidence}`,
          `Falsifier: ${attempt.valueAssessment.falsifier}`,
        ] : []),
        ...(attempt.claims?.length ? attempt.claims.map((claim) => [
          `Claim (${claim.confidence}): ${claim.statement}`,
          `Evidence: ${claim.evidence_summary}`,
          `Verification: ${claim.verification_method}`,
        ].join('\n')) : []),
        ...(attempt.failedApproaches?.length ? [`Failed approaches: ${attempt.failedApproaches.join(' | ')}`] : []),
        ...(attempt.limitations?.length ? [`Limitations: ${attempt.limitations.join(' | ')}`] : []),
        ...(attempt.nextActions?.length ? [`Next actions: ${attempt.nextActions.join(' | ')}`] : []),
        ...(attempt.citations?.length ? [`Citations: ${attempt.citations.map((citation) => `${citation.title} — ${citation.url}`).join(' | ')}`] : []),
      ].filter(Boolean).join('\n');
    } else if (attempt.recordSource === 'shared') {
      try {
        const summaryFile = resolveWithin(ATTEMPTS_ROOT, ...attempt.relativePublicDir.split('/'), 'summary.md');
        summary = await safeReadFile(ATTEMPTS_ROOT, summaryFile, 'utf8');
      } catch {
        summary = '';
      }
    } else {
      try {
        const record = await loadInternalAttempt(attempt.attemptId);
        summary = await safeReadFile(ATTEMPTS_ROOT, record.paths.summaryFile, 'utf8');
      } catch {
        summary = attempt.result ?? '';
      }
    }
    const excerpt = publicText(summary).slice(0, Math.min(3_000, remaining));
    if (!excerpt) continue;
    selected.push({
      attemptId: attempt.attemptId,
      route: attempt.route,
      reviewStatus: attempt.reviewStatus,
      disposition: attempt.disposition,
      excerpt,
    });
    remaining -= excerpt.length;
  }
  return {
    problem: canonical,
    attempts: selected,
    chars: selected.reduce((sum, item) => sum + item.excerpt.length, 0),
    truncated: ranked.length > selected.length,
  };
}

async function scanSharedAttemptRecords({ problem = null } = {}) {
  await initStorage();
  const records = [];
  const selectedProblems = Object.entries(PROBLEMS)
    .filter(([, candidate]) => !problem || candidate.canonical === problem);
  for (const [problemKey, candidate] of selectedProblems) {
    const problemDirectory = resolveWithin(ATTEMPTS_ROOT, candidate.canonical);
    const years = await readDirectoryEntries(ATTEMPTS_ROOT, problemDirectory);
    for (const year of years) {
      if (!year.isDirectory() || year.isSymbolicLink() || !/^\d{4}$/.test(year.name)) continue;
      const yearDirectory = resolveWithin(problemDirectory, year.name);
      const attempts = await readDirectoryEntries(ATTEMPTS_ROOT, yearDirectory);
      for (const entry of attempts) {
        if (records.length >= MAX_SHARED_ATTEMPTS) return records;
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-z0-9][a-z0-9._-]{7,179}$/.test(entry.name)) continue;
        const relativePublicDir = path.posix.join(candidate.canonical, year.name, entry.name);
        const manifestFile = resolveWithin(ATTEMPTS_ROOT, candidate.canonical, year.name, entry.name, 'attempt.yaml');
        let manifest;
        try {
          manifest = await safeReadFile(ATTEMPTS_ROOT, manifestFile, 'utf8');
        } catch {
          continue;
        }
        if (Buffer.byteLength(manifest) > MAX_SHARED_MANIFEST_BYTES) continue;
        const record = parseSharedAttemptManifest(manifest, {
          problemKey,
          problem: candidate,
          expectedAttemptId: entry.name,
          relativePublicDir,
          fallbackStartedAt: `${year.name}-01-01T00:00:00.000Z`,
        });
        if (record) records.push(record);
      }
    }
  }
  return records;
}

async function readDirectoryEntries(root, directory) {
  try {
    await assertNoSymlinks(root, directory);
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function parseSharedAttemptManifest(text, {
  problemKey,
  problem,
  expectedAttemptId,
  relativePublicDir,
  fallbackStartedAt,
}) {
  const attemptId = readYamlScalar(text, 'attempt_id');
  const manifestProblem = readYamlScalar(text, 'problem');
  const direction = readYamlScalar(text, 'target_direction');
  const artifactState = readYamlScalar(text, 'artifact_state');
  const taskId = readYamlScalar(text, 'task_id', 2);
  if (attemptId !== expectedAttemptId
    || manifestProblem !== problem.canonical
    || !Object.hasOwn(problem.routes, direction)
    || !['planned', 'running', 'checkpointed', 'completed', 'aborted'].includes(artifactState)
    || !taskId
    || !/^[a-z0-9][a-z0-9._-]{7,179}$/.test(taskId)) {
    return null;
  }
  const startedAt = normalizeTimestamp(readYamlScalar(text, 'started_at') ?? fallbackStartedAt);
  const reviewStatus = readYamlScalar(text, 'review_status') ?? 'unreviewed';
  return {
    id: attemptId,
    attemptId,
    problem: problem.canonical,
    problemId: problemKey,
    direction,
    routeId: direction,
    status: sharedRuntimeStatus(artifactState),
    artifactState,
    reviewStatus,
    startedAt,
    relativePublicDir,
    recordSource: 'shared',
    researchTask: {
      taskId,
      branchId: readYamlScalar(text, 'branch_id', 2) ?? 'unknown-branch',
      mode: readYamlScalar(text, 'mode', 2) ?? 'frontier',
      kind: readYamlScalar(text, 'kind', 2) ?? 'synthesis',
      title: readYamlScalar(text, 'title', 2) ?? 'Shared research task',
    },
  };
}

function readYamlScalar(text, key, indentation = 0) {
  const prefix = ' '.repeat(indentation);
  const line = text.split(/\r?\n/).find((candidate) => candidate.startsWith(`${prefix}${key}:`));
  if (!line) return null;
  const raw = line.slice(prefix.length + key.length + 1).trim();
  if (!raw || raw === 'null') return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return /^[A-Za-z0-9._-]+$/.test(raw) ? raw : null;
  }
}

function sharedRuntimeStatus(artifactState) {
  if (artifactState === 'completed') return 'completed';
  if (artifactState === 'aborted') return 'aborted';
  if (artifactState === 'checkpointed') return 'interrupted';
  return artifactState;
}

// Integration aliases retained for the runner manager and API layer.
export const createAttempt = createAttemptRecord;
export const readPublicEvents = readEvents;
export const recoverInterruptedAttempts = markInterruptedOnRecovery;

async function appendPublicEventUnlocked(record, event, { persistState = true } = {}) {
  const diskSequence = await readLastEventSequence(record.paths.eventsFile);
  const sequence = Math.max(Number(record.state.lastEventSequence) || 0, diskSequence) + 1;
  const sanitized = sanitizeEvent(record.state.attemptId, {
    ...event,
    sequence,
    timestamp: event?.timestamp ?? new Date().toISOString(),
  });
  await durableAppend(ATTEMPTS_ROOT, record.paths.eventsFile, `${JSON.stringify(sanitized)}\n`, 0o644);
  record.state.lastEventSequence = sequence;
  record.state.updatedAt = new Date().toISOString();
  if (persistState) await atomicWriteJson(PRIVATE_ROOT, record.paths.stateFile, record.state, 0o600);
  return sanitized;
}

async function loadInternalAttempt(attemptId) {
  await initStorage();
  assertIdentifier(attemptId, 'attempt id');
  const stateFile = resolveWithin(PRIVATE_RUNS_ROOT, attemptId, 'state.json');
  const raw = await safeReadFile(PRIVATE_ROOT, stateFile, 'utf8');
  const state = JSON.parse(raw);
  if (state.attemptId !== attemptId || typeof state.relativePublicDir !== 'string') {
    throw new Error('Attempt state identity is invalid.');
  }
  if (!state.manifest || state.manifest.attempt_id !== attemptId) throw new Error('Attempt manifest identity is invalid.');
  return { state, paths: attemptPaths(state) };
}

function attemptPaths({ attemptId, relativePublicDir }) {
  assertIdentifier(attemptId, 'attempt id');
  const relativeSegments = String(relativePublicDir).split('/').filter(Boolean);
  if (relativeSegments.length !== 3 || relativeSegments.at(-1) !== attemptId) {
    throw new Error('Attempt public directory is invalid.');
  }
  const publicDirectory = resolveWithin(ATTEMPTS_ROOT, ...relativeSegments);
  const privateDirectory = resolveWithin(PRIVATE_RUNS_ROOT, attemptId);
  return {
    publicDirectory,
    codeDirectory: resolveWithin(publicDirectory, 'code'),
    privateDirectory,
    manifestFile: resolveWithin(publicDirectory, 'attempt.yaml'),
    summaryFile: resolveWithin(publicDirectory, 'summary.md'),
    claimsFile: resolveWithin(publicDirectory, 'claims.jsonl'),
    eventsFile: resolveWithin(publicDirectory, 'evidence', 'events.jsonl'),
    environmentFile: resolveWithin(publicDirectory, 'evidence', 'environment.json'),
    researchBriefFile: resolveWithin(publicDirectory, 'code', 'RESEARCH_BRIEF.md'),
    reviewsReadmeFile: resolveWithin(publicDirectory, 'reviews', 'README.md'),
    requestFile: resolveWithin(privateDirectory, 'request.json'),
    stateFile: resolveWithin(privateDirectory, 'state.json'),
    rawEventsFile: resolveWithin(privateDirectory, 'provider-events.raw.jsonl'),
  };
}

async function collectArtifacts(publicDirectory) {
  const files = [];
  await walk(publicDirectory, publicDirectory, files);
  const artifacts = [];
  let totalBytes = 0;
  for (const file of files.sort()) {
    const relative = path.relative(publicDirectory, file).split(path.sep).join('/');
    if (relative === 'attempt.yaml' || relative.startsWith('reviews/')) continue;
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Attempt artifact changed during checkpointing.');
    if (info.size > MAX_ARTIFACT_FILE_BYTES) {
      throw new Error(`Attempt artifact exceeds the ${MAX_ARTIFACT_FILE_BYTES} byte per-file limit: ${relative}`);
    }
    totalBytes += info.size;
    if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) throw new Error('Attempt artifacts exceed the checkpoint byte limit.');
    const bytes = await safeReadFile(ATTEMPTS_ROOT, file);
    artifacts.push({
      path: relative,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      media_type: mediaType(relative),
      byte_length: bytes.length,
    });
  }
  return artifacts;
}

async function walk(root, directory, output) {
  await assertNoSymlinks(root, directory);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = resolveWithin(root, path.relative(root, directory), entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in attempt artifacts: ${entry.name}`);
    if (entry.isDirectory()) await walk(root, target, output);
    else if (entry.isFile()) {
      if (output.length >= MAX_ARTIFACT_FILES) throw new Error(`Attempt has more than ${MAX_ARTIFACT_FILES} artifact files.`);
      output.push(target);
    }
  }
}

async function readLastEventSequence(file) {
  const events = await readJsonLines(ATTEMPTS_ROOT, file);
  return events.reduce((maximum, event) => Math.max(maximum, Number(event.sequence) || 0), 0);
}

async function readJsonLines(root, file) {
  let text;
  try {
    text = await safeReadFile(root, file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) records.push(value);
    } catch {
      // A trailing partial record after a hard crash is ignored; preceding records remain replayable.
    }
  }
  return records;
}

async function atomicWriteJson(root, file, value, mode) {
  await atomicWriteFile(root, file, `${JSON.stringify(safeSerializable(value), null, 2)}\n`, mode);
}

async function atomicWriteFile(root, file, data, mode) {
  const target = resolveWithin(root, path.relative(root, file));
  await safeMkdirTree(root, path.dirname(target), mode === 0o600 ? 0o700 : 0o755);
  await assertNoSymlinks(root, target, { allowMissingLeaf: true });
  const temporary = resolveWithin(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function durableAppend(root, file, text, mode) {
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_PROVIDER_LINE_BYTES * 2) throw new Error('Durable record is too large.');
  const target = resolveWithin(root, path.relative(root, file));
  await safeMkdirTree(root, path.dirname(target), mode === 0o600 ? 0o700 : 0o755);
  await assertNoSymlinks(root, target, { allowMissingLeaf: true });
  const flags = FS_CONSTANTS.O_APPEND | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_WRONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0);
  const handle = await open(target, flags, mode);
  try {
    await handle.write(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureAppendFile(root, file, mode) {
  try {
    await safeReadFile(root, file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await atomicWriteFile(root, file, '', mode);
  }
}

async function safeReadFile(root, file, encoding = null) {
  const target = resolveWithin(root, path.relative(root, file));
  await assertNoSymlinks(root, target);
  return readFile(target, encoding ?? undefined);
}

async function safeMkdirTree(root, target, mode) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = resolveWithin(resolvedRoot, path.relative(resolvedRoot, target));
  const base = root === REPO_ROOT ? REPO_ROOT : resolvedRoot;
  if (base === resolvedTarget) {
    await ensureDirectoryNode(base, mode);
    return;
  }
  await ensureDirectoryNode(base, mode);
  const segments = path.relative(base, resolvedTarget).split(path.sep).filter(Boolean);
  let cursor = base;
  for (const segment of segments) {
    cursor = resolveWithin(base, path.relative(base, cursor), segment);
    await ensureDirectoryNode(cursor, mode);
  }
}

async function ensureDirectoryNode(directory, mode) {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe storage directory: ${directory}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(directory, { mode });
  }
}

async function assertNoSymlinks(root, target, { allowMissingLeaf = false } = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = resolveWithin(resolvedRoot, path.relative(resolvedRoot, target));
  const segments = path.relative(resolvedRoot, resolvedTarget).split(path.sep).filter(Boolean);
  let cursor = resolvedRoot;
  const rootInfo = await lstat(resolvedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('Storage root must be a real directory.');
  for (let index = 0; index < segments.length; index += 1) {
    cursor = resolveWithin(resolvedRoot, path.relative(resolvedRoot, cursor), segments[index]);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in runner storage: ${cursor}`);
      if (index < segments.length - 1 && !info.isDirectory()) throw new Error(`Storage parent is not a directory: ${cursor}`);
    } catch (error) {
      if (error.code === 'ENOENT' && (allowMissingLeaf || index < segments.length)) continue;
      throw error;
    }
  }
}

function sanitizeEvent(attemptId, event) {
  const value = sanitizePublicValue(event, 0);
  const type = clean(value.type || 'runner.event', 120).toLowerCase();
  const kind = clean(value.kind || '', 120).toLowerCase();
  if (/reasoning|chain[-_ ]?of[-_ ]?thought|thinking/.test(type)
    || /reasoning|chain[-_ ]?of[-_ ]?thought|thinking/.test(kind)) {
    throw new Error('Private reasoning events cannot be written to the public ledger.');
  }
  const sequence = Math.max(1, Math.floor(Number(value.sequence ?? value.seq) || 1));
  return {
    ...value,
    attemptId,
    seq: sequence,
    sequence,
    timestamp: normalizeTimestamp(value.timestamp),
    type,
  };
}

function sanitizePublicValue(value, depth) {
  if (depth > 6) return '[nested value omitted]';
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return publicText(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizePublicValue(item, depth + 1));
  if (typeof value !== 'object') return clean(String(value), 1_000);
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 200)) {
    if (/reasoning|chain.?of.?thought|thinking|authorization|api.?key|access.?token|refresh.?token|secret|password|account/i.test(key)) continue;
    result[clean(key, 100)] = sanitizePublicValue(item, depth + 1);
  }
  return result;
}

function normalizeRawRecord(line) {
  let payload = line;
  if (typeof line === 'string') {
    if (Buffer.byteLength(line) > MAX_PROVIDER_LINE_BYTES) throw new Error('Provider event line is too large.');
    const trimmed = line.replace(/[\r\n]+$/g, '');
    try {
      payload = JSON.parse(trimmed);
    } catch {
      payload = trimmed;
    }
  }
  return {
    recordedAt: new Date().toISOString(),
    payload: safeSerializable(payload),
  };
}

function safeSerializable(value) {
  const seen = new WeakSet();
  const json = JSON.stringify(value, (key, item) => {
    if (/authorization|api.?key|access.?token|refresh.?token|secret|password|runner.?token/i.test(key)) return undefined;
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'function' || typeof item === 'symbol' || item === undefined) return undefined;
    if (item && typeof item === 'object') {
      if (seen.has(item)) return '[circular]';
      seen.add(item);
    }
    return item;
  });
  return JSON.parse(json ?? 'null');
}

function syncManifestFromPatch(state, patch) {
  const manifest = state.manifest;
  manifest.artifact_state = normalizeArtifactState(patch.artifactState ?? state.artifactState);
  if (patch.model) manifest.agent.model = clean(patch.model, 160);
  if (patch.configuration) manifest.agent.configuration = clean(patch.configuration, 300);
  if (patch.summary) manifest.result.summary = clean(patch.summary, 9_500);
  if (patch.limitations) manifest.result.limitations = clean(patch.limitations, 9_500);
  if (patch.disposition) manifest.result.disposition = clean(patch.disposition, 120);
  if (patch.reviewStatus) manifest.review_status = clean(patch.reviewStatus, 80);
}

function publicView(state) {
  const manifest = state.manifest;
  return {
    id: state.attemptId,
    attemptId: state.attemptId,
    problem: manifest.problem,
    problemKey: state.problemKey,
    problemId: state.problemId ?? state.problemKey,
    problemSlug: manifest.problem,
    problemName: state.problemName,
    route: manifest.route,
    routeKey: state.routeKey,
    targetDirection: manifest.target_direction,
    routeId: state.direction ?? state.routeKey,
    direction: state.direction ?? state.routeKey,
    routeLabel: state.routeLabel,
    objective: manifest.objective,
    claimScope: manifest.claim_scope,
    researchTask: publicResearchTask(manifest.research_task),
    status: state.status,
    artifactState: manifest.artifact_state,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    updatedAt: state.updatedAt,
    createdAt: state.startedAt,
    completedAt: state.finishedAt,
    endedAt: state.finishedAt,
    elapsedSeconds: Math.max(0, Math.floor(((state.finishedAt ? Date.parse(state.finishedAt) : Date.now()) - Date.parse(state.startedAt)) / 1_000)),
    provider: manifest.agent.provider,
    interface: manifest.agent.interface,
    model: manifest.agent.model,
    effort: state.effort,
    riskMode: state.riskMode,
    keepPercent: state.keepPercent,
    requestedMinutes: state.requestedMinutes,
    allowedMinutes: state.allowedMinutes,
    budgetMinutes: state.allowedMinutes,
    configuration: manifest.agent.configuration,
    budget: safeSerializable(manifest.budget),
    result: manifest.result.summary,
    disposition: manifest.result.disposition,
    limitations: manifest.result.limitations,
    reviewStatus: manifest.review_status,
    parentAttemptIds: [...manifest.parent_attempt_ids],
    consultedAttemptIds: [...(manifest.provenance?.prior_artifacts_consulted ?? [])],
    relativePath: `attempts/${state.relativePublicDir}`,
    artifactPath: `attempts/${state.relativePublicDir}`,
    lastEventSequence: Number(state.lastEventSequence) || 0,
    checkpointCount: state.checkpoints.length,
    fileCount: manifest.artifacts.length,
    publication: state.publication ? safeSerializable(state.publication) : null,
    researchValue: state.researchValue ? safeSerializable(state.researchValue) : null,
  };
}

function attemptTaskId(attempt) {
  return attempt?.researchTask?.taskId ?? attempt?.researchTask?.id ?? null;
}

function attemptBranchId(attempt) {
  return attempt?.researchTask?.branchId ?? null;
}

function runtimeView(state) {
  const paths = attemptPaths(state);
  return {
    ...publicView(state),
    paths,
    codePath: paths.codeDirectory,
    priorContext: safeSerializable(state.priorContext),
    manifest: safeSerializable(state.manifest),
  };
}

function renderSummary(manifest) {
  const task = manifest.research_task
    ? `## Research task\n\n- Task: \`${manifest.research_task.task_id}\`\n- Branch: \`${manifest.research_task.branch_id}\`\n- Mode: \`${manifest.research_task.mode}\`\n- Kind: \`${manifest.research_task.kind}\`\n- Title: ${manifest.research_task.title}\n\n`
    : '';
  return `# Attempt summary\n\n${task}## Objective\n\n${manifest.objective}\n\n## Result\n\n${manifest.result.summary}\n\nDisposition: \`${manifest.result.disposition}\`\n\n## Evidence\n\nSee \`claims.jsonl\`, \`evidence/\`, and \`code/\`. Artifact hashes are recorded in \`attempt.yaml\`.\n\n## Limitations\n\n${manifest.result.limitations}\n\n## Review\n\nStatus: \`${manifest.review_status}\`. This repository status does not imply acceptance by Clay, a journal, or the mathematical community.\n`;
}

function renderManifestYaml(manifest) {
  const lines = [
    'schema_version: 1',
    `attempt_id: ${yamlScalar(manifest.attempt_id)}`,
    `parent_attempt_ids: ${yamlStringArray(manifest.parent_attempt_ids)}`,
    `supersedes: ${yamlStringArray(manifest.supersedes)}`,
    '',
    `problem: ${yamlScalar(manifest.problem)}`,
    `route: ${yamlScalar(manifest.route)}`,
    `target_direction: ${yamlScalar(manifest.target_direction)}`,
    `objective: ${yamlScalar(manifest.objective)}`,
    `claim_scope: ${yamlScalar(manifest.claim_scope)}`,
  ];
  if (manifest.research_task) {
    lines.push(
      'research_task:',
      `  task_id: ${yamlScalar(manifest.research_task.task_id)}`,
      `  branch_id: ${yamlScalar(manifest.research_task.branch_id)}`,
      `  mode: ${yamlScalar(manifest.research_task.mode)}`,
      `  kind: ${yamlScalar(manifest.research_task.kind)}`,
      `  title: ${yamlScalar(manifest.research_task.title)}`,
      `  source_attempt_ids: ${yamlStringArray(manifest.research_task.source_attempt_ids)}`,
    );
  }
  lines.push(
    `artifact_state: ${yamlScalar(manifest.artifact_state)}`,
    '',
    `started_at: ${yamlScalar(manifest.started_at)}`,
    `finished_at: ${manifest.finished_at ? yamlScalar(manifest.finished_at) : 'null'}`,
    `contributor: ${yamlScalar(manifest.contributor)}`,
    '',
    'agent:',
    `  provider: ${yamlScalar(manifest.agent.provider)}`,
    `  interface: ${yamlScalar(manifest.agent.interface)}`,
    `  model: ${yamlScalar(manifest.agent.model)}`,
    `  configuration: ${yamlScalar(manifest.agent.configuration)}`,
    `  adapter_version: ${yamlScalar(manifest.agent.adapter_version)}`,
    '',
    'budget:',
    `  requested_minutes: ${manifest.budget.requested_minutes}`,
    `  completed_minutes: ${manifest.budget.completed_minutes}`,
  );
  if (manifest.budget.quota_profile) lines.push(`  quota_profile: ${yamlScalar(manifest.budget.quota_profile)}`);
  lines.push(
    '',
    'provenance:',
    `  repository_revision: ${yamlScalar(manifest.provenance.repository_revision)}`,
    `  environment_manifest: ${yamlScalar(manifest.provenance.environment_manifest)}`,
    `  prior_artifacts_consulted: ${yamlStringArray(manifest.provenance.prior_artifacts_consulted)}`,
    '',
    'result:',
    `  disposition: ${yamlScalar(manifest.result.disposition)}`,
    `  summary: ${yamlScalar(manifest.result.summary)}`,
    `  limitations: ${yamlScalar(manifest.result.limitations)}`,
    '',
    'artifacts:',
  );
  if (manifest.artifacts.length === 0) lines.push('  []');
  for (const artifact of manifest.artifacts) {
    lines.push(
      `  - path: ${yamlScalar(artifact.path)}`,
      `    sha256: ${yamlScalar(artifact.sha256)}`,
      `    media_type: ${yamlScalar(artifact.media_type)}`,
      `    byte_length: ${artifact.byte_length}`,
    );
  }
  lines.push('', `review_status: ${yamlScalar(manifest.review_status)}`, '');
  return `${lines.join('\n')}\n`;
}

function yamlScalar(value) {
  return JSON.stringify(String(value));
}

function yamlStringArray(values) {
  return `[${(values ?? []).map((value) => yamlScalar(value)).join(', ')}]`;
}

function resolveProblem(value) {
  const entry = Object.entries(PROBLEMS).find(([key, problem]) => key === value || problem.canonical === value);
  if (!entry) throw new Error('The research problem is not supported.');
  return { key: entry[0], ...entry[1] };
}

function resolveRoute(problem, value) {
  if (value && problem.routes[value]) return { key: value, ...problem.routes[value] };
  const entry = Object.entries(problem.routes).find(([, route]) => route.protocolRoute === value);
  if (!entry) throw new Error('The selected route is not supported for this problem.');
  return { key: entry[0], ...entry[1] };
}

function normalizeAttemptIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.slice(0, 1_000).map((value) => assertIdentifier(String(value), 'prior attempt id')))];
}

function normalizeResearchTask(value) {
  if (!value) return null;
  const taskId = requireString(clean(value.taskId ?? value.id, 180), 'research task id', { min: 8, max: 180 });
  const branchId = requireString(clean(value.branchId, 120), 'research branch id', { min: 2, max: 120 });
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(taskId) || !/^[a-z0-9][a-z0-9._-]*$/.test(branchId)) {
    throw new Error('Research task identifiers are invalid.');
  }
  const mode = clean(value.mode, 40);
  if (!['recommended', 'frontier', 'explore', 'verify'].includes(mode)) {
    throw new Error('Research task mode is invalid.');
  }
  const kind = clean(value.kind, 40);
  if (!['proof', 'counterexample-search', 'computation', 'formalization', 'review', 'synthesis', 'exploration'].includes(kind)) {
    throw new Error('Research task kind is invalid.');
  }
  return {
    taskId,
    branchId,
    mode,
    kind,
    title: requireString(clean(value.title, 160), 'research task title', { min: 8, max: 160 }),
    sourceAttemptIds: normalizeAttemptIds(value.sourceAttemptIds ?? []),
  };
}

function publicResearchTask(value) {
  if (!value) return null;
  return {
    taskId: value.task_id,
    branchId: value.branch_id,
    mode: value.mode,
    kind: value.kind,
    title: value.title,
  };
}

function normalizeArtifactState(value) {
  if (['planned', 'running', 'checkpointed', 'completed', 'aborted'].includes(value)) return value;
  if (value === 'completed') return 'completed';
  if (['failed', 'interrupted', 'stopped', 'quota-stopped', 'quota_stopped'].includes(value)) return 'aborted';
  if (['starting', 'checkpointing', 'stopping'].includes(value)) return 'running';
  return 'planned';
}

function normalizeFinalStatus(value) {
  if (value === 'completed') return 'completed';
  if (['failed', 'interrupted', 'stopped', 'quota-stopped', 'quota_stopped', 'aborted'].includes(value)) return value;
  return 'completed';
}

function normalizeTimestamp(value) {
  const date = new Date(value ?? Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function configurationLabel(config) {
  return [
    `risk=${clean(config.riskMode || 'balanced', 40)}`,
    `effort=${clean(config.effort || 'default', 40)}`,
    `network=${config.networkEnabled ? 'research-only' : 'off'}`,
  ].join('; ');
}

function mediaType(relative) {
  const extension = path.extname(relative).toLowerCase();
  return ({
    '.json': 'application/json',
    '.jsonl': 'application/x-ndjson',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.py': 'text/x-python',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.ts': 'text/typescript',
    '.tsx': 'text/typescript',
    '.lean': 'text/plain',
    '.v': 'text/plain',
    '.csv': 'text/csv',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.pdf': 'application/pdf',
  })[extension] ?? 'application/octet-stream';
}

function defaultLimitations(status) {
  return status === 'completed'
    ? 'This bounded, unreviewed attempt is not an accepted solution. Every claim still requires independent checking at its declared scope.'
    : 'The attempt ended before normal completion. Partial files may be inconsistent and must be inspected before reuse.';
}

function reviewPriority(status) {
  return ({
    'mechanically-checked': 6,
    reproduced: 5,
    'specialist-reviewed': 4,
    disputed: 3,
    'schema-checked': 2,
    unreviewed: 1,
    superseded: 0,
    withdrawn: 0,
  })[status] ?? 0;
}

function clean(value, max) {
  return publicText(String(value ?? '')).replace(/\u0000/g, '').trim().slice(0, max);
}

function publicText(value) {
  return sanitizePublicText(value, PUBLIC_PATH_REPLACEMENTS);
}

function literalPattern(value) {
  return new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}

async function queued(key, action) {
  const previous = operationQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  operationQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (operationQueues.get(key) === current) operationQueues.delete(key);
  }
}
