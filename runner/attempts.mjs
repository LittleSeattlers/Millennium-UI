import {
  CODEX_EFFORTS,
  FINALIZATION_RESERVE_MINUTES,
  MIN_USEFUL_RUN_MINUTES,
  PROBLEMS,
  PROVIDERS,
  RISK_MODES,
  RUNNER_VERSION,
} from './constants.mjs';
import { estimateQuota } from './quota.mjs';
import {
  HttpError,
  requireChoice,
  requireNumber,
  requireString,
  sanitizePublicText,
} from './security.mjs';
import {
  appendPublicEvent,
  appendRawEvent,
  checkpointAttempt,
  createAttempt,
  finalizeAttempt,
  getAttempt,
  getAttemptPublicationState,
  initStorage,
  listAttempts,
  listResearchRecords,
  loadPriorContext,
  loadQuotaSnapshots,
  readPublicEvents,
  recoverInterruptedAttempts,
  saveQuotaSnapshot,
  updateAttemptState,
} from './storage.mjs';
import { buildFinalizationPrompt, buildResearchPrompt } from './prompt.mjs';
import {
  RESEARCH_MODES,
  leaseResearchTask,
  listResearchFrontier,
  prepareResearchTask,
  releaseResearchTaskLease,
} from './frontier.mjs';
import { probeCodex, startCodexRun } from './providers/codex.mjs';
import {
  cancelClaim,
  claimResearchTask,
  listOpenClaims,
  publishContribution,
  syncSharedLedger,
} from './github.mjs';
import { prepareContribution } from './contribution.mjs';
import { classifyTerminalDisposition } from './terminal.mjs';

function unavailableProvider(id) {
  return {
    id,
    installed: false,
    ready: false,
    authKind: 'unknown',
    version: null,
    planType: null,
    reason: 'Provider status has not been checked yet.',
    snapshot: null,
    installCommand: null,
  };
}

export class CoordinationSingleFlight {
  constructor() {
    this.pending = null;
    this.pendingForce = false;
  }

  async run(force, operation) {
    const pending = this.pending;
    const pendingForce = this.pendingForce;
    if (pending) {
      try {
        const value = await pending;
        if (!force || pendingForce) return value;
      } catch (error) {
        if (!force || pendingForce) throw error;
      }
      return this.run(true, operation);
    }

    const task = Promise.resolve().then(() => operation(force));
    this.pending = task;
    this.pendingForce = force;
    try {
      return await task;
    } finally {
      if (this.pending === task) {
        this.pending = null;
        this.pendingForce = false;
      }
    }
  }
}

export class AttemptManager {
  constructor() {
    this.active = null;
    this.starting = false;
    this.providers = new Map(PROVIDERS.map((id) => [id, unavailableProvider(id)]));
    this.listeners = new Map();
    this.refreshPromise = null;
    this.coordinationSync = new CoordinationSingleFlight();
    this.coordination = { ready: false, syncedAt: null, error: null };
  }

  async init() {
    await initStorage();
    const recovered = await recoverInterruptedAttempts();
    // GitHub may be slow or temporarily unavailable. Keep that network work off
    // the connector's startup-critical path so the native launch ticket can be
    // armed immediately; refresh/start still require a successful sync.
    void this.#syncCoordination()
      .then(async () => {
        for (const attempt of recovered) await this.retryPublication(attempt.id).catch(() => {});
      })
      .catch(() => {});
  }

  health() {
    return {
      ok: true,
      version: RUNNER_VERSION,
      localOnly: true,
      starting: this.starting,
      activeAttemptId: this.active?.attempt.id ?? null,
      coordination: { ...this.coordination },
    };
  }

  async providerState() {
    const result = [];
    for (const provider of PROVIDERS) {
      const snapshots = await loadQuotaSnapshots(provider);
      const latest = snapshots.at(-1) ?? null;
      const status = this.providers.get(provider) ?? unavailableProvider(provider);
      result.push({
        ...status,
        snapshot: latest,
        estimate: this.#estimateFrom(provider, latest, snapshots, 'balanced', 10),
      });
    }
    return { providers: result, activeAttemptId: this.active?.attempt.id ?? null, coordination: { ...this.coordination } };
  }

  async refreshProviders(provider = null) {
    if (provider !== null) requireChoice(provider, PROVIDERS, 'provider');
    if (this.refreshPromise) return this.refreshPromise;
    const targets = provider ? [provider] : [...PROVIDERS];
    const task = (async () => {
      await Promise.all(targets.map(async (id) => {
        let status;
        if (this.active?.attempt.provider === 'codex' && this.active.handle?.refreshQuota) {
          await this.active.handle.refreshQuota();
          status = this.providers.get(id);
        } else {
          status = await probeCodex({ onSnapshot: (snapshot) => this.#recordSnapshot(snapshot) });
        }
        if (status) this.providers.set(id, status);
        return status;
      }));
      try {
        await this.#syncCoordination();
      } catch {
        await this.#syncCoordination({ force: true }).catch(() => {});
      }
      return this.providerState();
    })();
    this.refreshPromise = task;
    try {
      return await task;
    } finally {
      if (this.refreshPromise === task) this.refreshPromise = null;
    }
  }

  async saveManualSnapshot() {
    throw new HttpError(400, 'Codex quota is read automatically from the local Codex app server.', 'manual_snapshot_refused');
  }

  async estimate({ provider, riskMode = 'balanced', keepPercent = 10 } = {}) {
    requireChoice(provider, PROVIDERS, 'provider');
    requireChoice(riskMode, Object.keys(RISK_MODES), 'riskMode');
    requireNumber(keepPercent, 'keepPercent', { min: 0, max: 95 });
    const snapshots = await loadQuotaSnapshots(provider);
    const snapshot = snapshots.at(-1) ?? null;
    return {
      provider,
      snapshot,
      estimate: this.#estimateFrom(provider, snapshot, snapshots, riskMode, keepPercent),
    };
  }

  async list() {
    return {
      attempts: await listAttempts(),
      activeAttemptId: this.active?.attempt.id ?? null,
    };
  }

  async frontier({ problemId, direction, safeMinutes = 30 } = {}) {
    const problemKey = requireChoice(problemId, Object.keys(PROBLEMS), 'problemId');
    const routeKey = requireChoice(direction, Object.keys(PROBLEMS[problemKey].routes), 'direction');
    const minutes = Math.floor(requireNumber(safeMinutes, 'safeMinutes', { min: 1, max: 120 }));
    const shared = await this.#researchInputs();
    return listResearchFrontier({
      problemId: problemKey,
      direction: routeKey,
      safeMinutes: minutes,
      attempts: shared.attempts,
      externalClaims: shared.claims,
    });
  }

  async resolveResearchTask({
    problemId,
    direction,
    taskMode = 'recommended',
    taskId = null,
    newDirection = null,
    safeMinutes = 30,
  } = {}) {
    const problemKey = requireChoice(problemId, Object.keys(PROBLEMS), 'problemId');
    const routeKey = requireChoice(direction, Object.keys(PROBLEMS[problemKey].routes), 'direction');
    const mode = requireChoice(taskMode, RESEARCH_MODES, 'taskMode');
    const minutes = Math.floor(requireNumber(safeMinutes, 'safeMinutes', { min: 1, max: 120 }));
    const shared = await this.#researchInputs();
    return prepareResearchTask({
      mode,
      taskId,
      newDirection,
      problemId: problemKey,
      direction: routeKey,
      safeMinutes: minutes,
      attempts: shared.attempts,
      externalClaims: shared.claims,
    });
  }

  async get(id) {
    const attempt = await getAttempt(id);
    if (!attempt) throw new HttpError(404, 'Attempt was not found.', 'not_found');
    return attempt;
  }

  async events(id, after = 0) {
    await this.get(id);
    return readPublicEvents(id, after);
  }

  async retryPublication(id) {
    if (this.active?.attempt.id === id) throw new HttpError(409, 'Wait for the active attempt to finish before retrying publication.', 'attempt_active');
    const attempt = await this.get(id);
    if (!['completed', 'interrupted', 'aborted', 'failed'].includes(attempt.status)) {
      throw new HttpError(409, 'Only a terminal attempt can be published.', 'attempt_not_terminal');
    }
    const state = await getAttemptPublicationState(id);
    if (state.publication?.status === 'submitted') return attempt;
    if (!state.publicationHandle) throw new HttpError(409, 'No recoverable draft contribution claim exists for this attempt.', 'publication_unavailable');
    const prepared = await prepareContribution(attempt);
    try {
      const publication = await publishContribution(state.publicationHandle, prepared.record);
      await updateAttemptState(id, {
        publication: {
          status: 'submitted',
          prUrl: publication.prUrl,
          prNumber: publication.prNumber,
          path: publication.path,
          warning: prepared.warning,
          usedStructuredProposal: prepared.usedProposal,
        },
      });
      await appendPublicEvent(id, {
        kind: 'PUBLISH',
        message: 'Sanitized research contribution submitted.',
        detail: `Contribution PR #${publication.prNumber} is ready for automatic data-only validation.`,
      });
      return this.get(id);
    } catch (error) {
      await updateAttemptState(id, {
        publication: { status: 'failed', error: safeError(error), prUrl: state.publicationHandle.prUrl ?? null },
      });
      throw new HttpError(502, `Contribution submission failed: ${safeError(error)}`, 'publication_failed');
    }
  }

  subscribe(id, listener) {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(id);
    };
  }

  async start(body) {
    if (this.active || this.starting) throw new HttpError(409, 'Another attempt is already starting or running.', 'attempt_active');
    this.starting = true;
    let heldLease = null;
    let claimHandle = null;
    try {
      const config = this.#validateStart(body);
      requireUsefulRunMinutes(config.requestedMinutes);

      await this.refreshProviders(config.provider);
      const providerStatus = this.providers.get(config.provider);
      if (!providerStatus?.ready || providerStatus.authKind !== 'subscription') {
        throw new HttpError(409, providerStatus?.reason ?? 'Subscription authentication is not ready.', 'provider_not_ready');
      }

      const quota = await this.estimate(config);
      if (quota.estimate.status !== 'ready') {
        throw new HttpError(409, quota.estimate.reason, 'quota_blocked');
      }
      const allowedMinutes = Math.min(config.requestedMinutes, quota.estimate.allowedMinutes);
      requireUsefulRunMinutes(allowedMinutes);

      const shared = await this.#researchInputs({ forceSync: true });
      const researchTask = await prepareResearchTask({
        mode: config.taskMode,
        taskId: config.taskId,
        newDirection: config.newDirection,
        problemId: config.problemId,
        direction: config.direction,
        safeMinutes: allowedMinutes,
        attempts: shared.attempts,
        externalClaims: shared.claims,
      });
      if (config.preparedResearchTask
        && (config.preparedResearchTask.id !== researchTask.id
          || config.preparedResearchTask.objective !== researchTask.objective)) {
        throw new HttpError(
          409,
          'The shared research frontier changed after selection. Review the refreshed task before starting.',
          'research_task_changed',
        );
      }
      claimHandle = await claimResearchTask({
        task: researchTask,
        problem: config.problem,
        problemId: config.problemId,
        direction: config.direction,
        minutes: allowedMinutes,
      });
      const taskLeaseOwner = config.taskLeaseOwner;
      await leaseResearchTask(researchTask, taskLeaseOwner, allowedMinutes);
      heldLease = { taskId: researchTask.id, ownerId: taskLeaseOwner };
      config.researchTask = researchTask;
      config.objective = researchTask.objective;
      config.parentAttemptIds = researchTask.sourceAttemptIds;
      config.priorContext = await loadPriorContext(config.problem, {
        includeAttemptIds: researchTask.sourceAttemptIds,
      });

      const attempt = await createAttempt({
        ...config,
        userRequestedMinutes: config.requestedMinutes,
        requestedMinutes: allowedMinutes,
        allowedMinutes,
        checkpointMinutes: quota.estimate.checkpointMinutes,
        quotaEstimate: quota.estimate,
        snapshot: quota.snapshot,
        adapterVersion: RUNNER_VERSION,
      });
      const prompt = await buildResearchPrompt({ attempt, config, quotaEstimate: quota.estimate });
      let settleLaunch;
      const launchSettled = new Promise((resolve) => { settleLaunch = resolve; });
      const startedMs = Date.now();
      const active = {
        attempt,
        handle: null,
        done: null,
        stopping: false,
        pendingStopReason: null,
        stopDispatched: false,
        stopPromise: null,
        launchSettled,
        settleLaunch,
        startedMs,
        deadlineMs: startedMs + allowedMinutes * 60_000,
        publicQueue: Promise.resolve(),
        rawQueue: Promise.resolve(),
        timers: [],
        hardStopTimer: null,
        finalizationTimer: null,
        finalizationRequested: false,
        finalizationPending: false,
        finalizationPromise: null,
        guardPending: false,
        finalizing: null,
        researchTaskLease: heldLease,
        publicationClaim: claimHandle,
      };
      this.active = active;

      const emit = (event) => this.#enqueuePublic(active, event);
      const raw = (line) => {
        active.rawQueue = active.rawQueue.then(() => appendRawEvent(attempt.id, line));
        return active.rawQueue;
      };
      const snapshot = async (value, options = {}) => {
        const saved = await this.#recordSnapshot(value, options);
        await emit({
          kind: 'QUOTA',
          message: 'Codex quota meters refreshed.',
          detail: saved.windows.map((window) => `${window.label}: ${Math.round(window.remainingPercent)}% left`).join(' | '),
        });
        await this.#applyQuotaGuard(active, saved);
      };

      try {
        await updateAttemptState(attempt.id, {
          publication: { status: 'claimed', prUrl: claimHandle.prUrl, prNumber: claimHandle.prNumber },
          publicationHandle: claimHandle,
        });
        await emit({
          kind: 'CLAIM',
          message: 'Shared research task claimed.',
          detail: `Draft contribution PR #${claimHandle.prNumber} reserves this task until the bounded run finishes.`,
        });
        await emit({
          kind: 'START',
          message: 'Codex attempt started.',
          detail: `${allowedMinutes} minute hard limit; the final ${FINALIZATION_RESERVE_MINUTES} minutes are reserved for a durable result.`,
        });
        active.handle = await startCodexRun({
          attempt,
          prompt,
          effort: config.effort,
          model: config.model,
          networkAccess: config.networkAccess,
          onEvent: emit,
          onRaw: raw,
          onSnapshot: snapshot,
        });
        await updateAttemptState(attempt.id, {
          status: 'running',
          providerSessionId: active.handle.threadId ?? active.handle.sessionId ?? null,
        });
        active.done = this.#finishWhenDone(active);
        active.settleLaunch();
        if (active.pendingStopReason) await this.#dispatchStop(active);
        else if (this.active === active && !active.finalizing) this.#armGuards(active, quota.estimate);
        return await this.get(attempt.id);
      } catch (error) {
        try {
          await emit({ kind: 'ERROR', level: 'error', message: 'Provider launch failed.', detail: safeError(error) });
        } catch { /* finalization still releases the task lease */ }
        const finishing = this.#finish(active, { status: 'failed', error: safeError(error), usage: null });
        active.settleLaunch();
        await finishing;
        throw new HttpError(502, `Provider launch failed: ${safeError(error)}`, 'provider_launch_failed');
      }
    } catch (error) {
      if (heldLease && this.active?.researchTaskLease !== heldLease) {
        await releaseResearchTaskLease(heldLease.taskId, heldLease.ownerId).catch(() => {});
      }
      if (claimHandle && this.active?.publicationClaim !== claimHandle) {
        await cancelClaim(claimHandle).catch(() => {});
      }
      throw error;
    } finally {
      this.starting = false;
    }
  }

  async checkpoint(id, { stop = false } = {}) {
    await this.get(id);
    if (this.active?.attempt.id !== id) {
      throw new HttpError(409, 'Only the active attempt can be checkpointed.', 'attempt_not_active');
    }
    const checkpoint = await checkpointAttempt(id, stop ? 'checkpoint-and-stop' : 'manual');
    await this.#enqueuePublic(this.active, {
      kind: 'CHECKPOINT',
      message: 'Durable checkpoint captured.',
      detail: `${checkpoint.fileCount ?? 0} artifact files indexed.`,
    });
    if (stop) await this.stop(id, 'checkpoint-and-stop');
    return { attempt: await this.get(id), checkpoint };
  }

  async stop(id, reason = 'user') {
    await this.get(id);
    const active = this.active;
    if (!active || active.attempt.id !== id) return this.get(id);
    if (!active.stopping) {
      active.stopping = true;
      active.pendingStopReason = reason;
      await this.#enqueuePublic(active, {
        kind: 'GUARD',
        level: 'warning',
        message: reason === 'user' ? 'Stop requested by contributor.' : `Run stopped: ${reason}.`,
        detail: 'The provider is being interrupted; written files remain in the attempt artifact.',
      });
      await checkpointAttempt(id, reason);
    }
    await active.launchSettled;
    await this.#dispatchStop(active);
    await (active.done ?? active.finalizing ?? Promise.resolve());
    return this.get(id);
  }

  async #dispatchStop(active) {
    if (!active.handle) return;
    if (!active.stopDispatched) {
      active.stopDispatched = true;
      active.stopPromise = active.handle.stop();
    }
    await active.stopPromise;
  }

  async #syncCoordination({ force = false } = {}) {
    return this.coordinationSync.run(force, async (effectiveForce) => {
      try {
        const state = await syncSharedLedger({ force: effectiveForce });
        this.coordination = { ready: true, syncedAt: state.syncedAt, error: null };
        return state;
      } catch (error) {
        this.coordination = { ready: false, syncedAt: this.coordination.syncedAt, error: safeError(error) };
        throw error;
      }
    });
  }

  async #researchInputs({ forceSync = false } = {}) {
    try {
      await this.#syncCoordination({ force: forceSync });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        503,
        'GitHub coordination is temporarily unavailable. Click Refresh Codex to retry.',
        'coordination_unavailable',
      );
    }
    const attempts = await listResearchRecords({ limit: 2_000 });
    let claims;
    try {
      claims = await listOpenClaims();
    } catch (error) {
      this.coordination = {
        ready: false,
        syncedAt: this.coordination.syncedAt,
        error: safeError(error),
      };
      throw new HttpError(
        503,
        'GitHub coordination is temporarily unavailable. Click Refresh Codex to retry.',
        'coordination_unavailable',
      );
    }
    return {
      attempts: attempts.filter((attempt) => attempt.recordSource !== 'shared-contribution-quarantined'),
      claims,
    };
  }

  #validateStart(body) {
    const provider = requireChoice(body?.provider, PROVIDERS, 'provider');
    const problemId = requireChoice(body?.problemId, Object.keys(PROBLEMS), 'problemId');
    const problem = PROBLEMS[problemId];
    const direction = requireChoice(body?.direction, Object.keys(problem.routes), 'direction');
    const route = problem.routes[direction];
    const riskMode = requireChoice(body?.riskMode ?? 'balanced', Object.keys(RISK_MODES), 'riskMode');
    const keepPercent = requireNumber(body?.keepPercent ?? 10, 'keepPercent', { min: 0, max: 95 });
    const requestedMinutes = Math.floor(requireNumber(body?.requestedMinutes ?? 30, 'requestedMinutes', { min: 1, max: 120 }));
    const effort = requireChoice(body?.effort ?? 'high', CODEX_EFFORTS, 'effort');
    const model = 'default';
    const objective = requireString(body?.objective, 'objective', { min: 20, max: 2000 });
    const taskMode = requireChoice(body?.taskMode ?? 'explore', RESEARCH_MODES, 'taskMode');
    const taskId = body?.taskId == null
      ? null
      : requireString(body.taskId, 'taskId', { min: 8, max: 180 });
    if (['frontier', 'verify'].includes(taskMode) && !taskId) {
      throw new HttpError(400, 'Choose a research task for this mode.', 'validation');
    }
    const newDirection = taskMode === 'explore'
      ? requireString(body?.newDirection ?? objective, 'newDirection', { min: 20, max: 600 })
      : null;
    const taskLeaseOwner = body?.taskLeaseOwner == null
      ? 'local-runner'
      : requireString(body.taskLeaseOwner, 'task lease owner', { min: 8, max: 160 });
    return {
      provider,
      problemId,
      problem: problem.canonical,
      problemName: problem.name,
      direction,
      directionLabel: route.label,
      route: route.protocolRoute,
      riskMode,
      keepPercent,
      requestedMinutes,
      effort,
      model,
      networkAccess: body?.networkAccess === true,
      objective,
      taskMode,
      taskId,
      newDirection,
      taskLeaseOwner,
      preparedResearchTask: body?.preparedResearchTask ?? null,
    };
  }

  #estimateFrom(provider, snapshot, snapshots, riskMode, keepPercent) {
    void provider;
    return estimateQuota({ snapshot, snapshots, riskMode, keepPercent });
  }

  async #recordSnapshot(snapshot) {
    await saveQuotaSnapshot(snapshot);
    return snapshot;
  }

  async #applyQuotaGuard(active, snapshot) {
    if (this.active !== active || active.stopping || active.finalizing) return;
    const history = await loadQuotaSnapshots(active.attempt.provider);
    if (this.active !== active || active.stopping || active.finalizing) return;
    const estimate = this.#estimateFrom(
      active.attempt.provider,
      snapshot,
      history,
      active.attempt.riskMode,
      active.attempt.keepPercent,
    );
    if (estimate.status !== 'ready') {
      if (!active.handle) active.pendingStopReason = estimate.reason;
      else void this.stop(active.attempt.id, estimate.reason);
      return;
    }
    const tightenedDeadline = Math.min(active.deadlineMs, Date.now() + estimate.allowedMinutes * 60_000);
    if (tightenedDeadline < active.deadlineMs) {
      active.deadlineMs = tightenedDeadline;
      this.#resetHardStop(active);
      this.#resetFinalization(active);
    }
  }

  #armGuards(active, estimate) {
    if (this.active !== active || active.stopping || active.finalizing) return;
    this.#resetHardStop(active);
    this.#resetFinalization(active);

    const checkpointMs = Math.max(60_000, estimate.checkpointMinutes * 60_000);
    const checkpoint = setInterval(() => {
      void checkpointAttempt(active.attempt.id, 'scheduled').then((result) => this.#enqueuePublic(active, {
        kind: 'CHECKPOINT',
        message: 'Scheduled checkpoint captured.',
        detail: `${result.fileCount ?? 0} artifact files indexed.`,
      })).catch((error) => void this.stop(active.attempt.id, `checkpoint failed: ${safeError(error)}`));
    }, checkpointMs);
    checkpoint.unref?.();
    active.timers.push(checkpoint);

    const quotaGuard = setInterval(() => {
      if (active.guardPending || active.stopping || this.active !== active) return;
      active.guardPending = true;
      void (async () => {
        const history = await loadQuotaSnapshots(active.attempt.provider);
        const latest = history.at(-1) ?? null;
        const current = this.#estimateFrom(
          active.attempt.provider,
          latest,
          history,
          active.attempt.riskMode,
          active.attempt.keepPercent,
        );
        if (current.status !== 'ready') await this.stop(active.attempt.id, current.reason);
      })().catch((error) => this.stop(active.attempt.id, `quota guard failed: ${safeError(error)}`))
        .finally(() => { active.guardPending = false; });
    }, 30_000);
    quotaGuard.unref?.();
    active.timers.push(quotaGuard);

    if (active.attempt.provider === 'codex' && active.handle?.refreshQuota) {
      const refresh = setInterval(() => void active.handle.refreshQuota(), 2 * 60_000);
      refresh.unref?.();
      active.timers.push(refresh);
    }
  }

  async #finishWhenDone(active) {
    try {
      const result = await active.handle.completion;
      return this.#finish(active, result);
    } catch (error) {
      return this.#finish(active, { status: 'failed', error: safeError(error), usage: null });
    }
  }

  async #finish(active, result) {
    if (active.finalizing) return active.finalizing;
    active.finalizing = (async () => {
      try {
        if (active.hardStopTimer) clearTimeout(active.hardStopTimer);
        if (active.finalizationTimer) clearTimeout(active.finalizationTimer);
        for (const timer of active.timers) clearTimeout(timer);
        await active.rawQueue.catch(() => {});
        try { await checkpointAttempt(active.attempt.id, 'final'); } catch { /* finalizer records the failure */ }
        await finalizeAttempt(active.attempt.id, {
          status: result.status,
          disposition: classifyTerminalDisposition({
            status: result.status,
            stopReason: active.pendingStopReason,
          }),
          error: result.error ? safeError(result.error) : null,
          usage: result.usage ?? null,
          completedMinutes: Math.max(0, Math.ceil((Date.now() - active.startedMs) / 60_000)),
        });
        let publicationDetail = 'The canonical contribution could not be submitted; raw work remains private and recoverable.';
        try {
          const finalized = await this.get(active.attempt.id);
          const prepared = await prepareContribution(finalized);
          const publication = await publishContribution(active.publicationClaim, prepared.record);
          await updateAttemptState(active.attempt.id, {
            publication: {
              status: 'submitted',
              prUrl: publication.prUrl,
              prNumber: publication.prNumber,
              path: publication.path,
              warning: prepared.warning,
              usedStructuredProposal: prepared.usedProposal,
            },
          });
          publicationDetail = `Contribution PR #${publication.prNumber} is ready for automatic data-only validation.`;
          await this.#enqueuePublic(active, {
            kind: 'PUBLISH',
            message: 'Sanitized research contribution submitted.',
            detail: publicationDetail,
          });
        } catch (error) {
          await updateAttemptState(active.attempt.id, {
            publication: { status: 'failed', error: safeError(error), prUrl: active.publicationClaim?.prUrl ?? null },
          }).catch(() => {});
          await this.#enqueuePublic(active, {
            kind: 'PUBLISH',
            level: 'error',
            message: 'Automatic contribution submission failed.',
            detail: 'The complete workspace remains private and recoverable. Reconnect after checking GitHub access to retry publication.',
          });
        }
        await this.#enqueuePublic(active, {
          kind: 'FINAL',
          level: result.status === 'completed' ? 'info' : 'warning',
          message: `Attempt ${result.status}.`,
          detail: result.error ? safeError(result.error) : publicationDetail,
        });
        await active.publicQueue;
        return this.get(active.attempt.id);
      } finally {
        if (active.researchTaskLease) {
          await releaseResearchTaskLease(
            active.researchTaskLease.taskId,
            active.researchTaskLease.ownerId,
          ).catch(() => {});
        }
        if (this.active === active) this.active = null;
      }
    })();
    return active.finalizing;
  }

  #resetHardStop(active) {
    if (active.hardStopTimer) clearTimeout(active.hardStopTimer);
    active.hardStopTimer = null;
    if (this.active !== active || active.finalizing) return;
    active.hardStopTimer = setTimeout(
      () => void this.stop(active.attempt.id, 'safe time budget exhausted'),
      Math.max(1, active.deadlineMs - Date.now()),
    );
    active.hardStopTimer.unref?.();
  }

  #resetFinalization(active) {
    if (active.finalizationTimer) clearTimeout(active.finalizationTimer);
    active.finalizationTimer = null;
    if (this.active !== active || active.stopping || active.finalizing || active.finalizationRequested) return;
    const delayMs = finalizationDelayMs(active.deadlineMs);
    if (delayMs <= 0) {
      active.finalizationPending = true;
      void this.#requestFinalization(active);
      return;
    }
    active.finalizationTimer = setTimeout(
      () => void this.#requestFinalization(active),
      delayMs,
    );
    active.finalizationTimer.unref?.();
  }

  #requestFinalization(active) {
    if (active.finalizationPromise) return active.finalizationPromise;
    if (this.active !== active || active.stopping || active.finalizing || active.finalizationRequested) {
      return Promise.resolve(null);
    }
    if (!active.handle?.requestFinalization) {
      active.finalizationPending = true;
      return Promise.resolve(null);
    }

    active.finalizationRequested = true;
    active.finalizationPending = false;
    if (active.finalizationTimer) clearTimeout(active.finalizationTimer);
    active.finalizationTimer = null;
    const secondsRemaining = Math.max(0, Math.floor((active.deadlineMs - Date.now()) / 1_000));
    const prompt = buildFinalizationPrompt({
      reason: 'The runner has entered its reserved finalization window.',
      secondsRemaining: Math.max(15, secondsRemaining),
    });
    active.finalizationPromise = (async () => {
      await this.#enqueuePublic(active, {
        kind: 'FINALIZE',
        message: 'Reserved finalization phase started.',
        detail: `Codex has up to ${secondsRemaining} seconds to preserve its strongest supported result and next action.`,
      });
      try {
        const outcome = await active.handle.requestFinalization(prompt);
        if (outcome?.steered === false) {
          await this.#enqueuePublic(active, {
            kind: 'FINALIZE',
            level: 'warning',
            message: 'Codex finished before the finalization reminder was delivered.',
            detail: 'The runner will publish the latest valid durable checkpoint.',
          });
        }
      } catch (error) {
        await this.#enqueuePublic(active, {
          kind: 'FINALIZE',
          level: 'warning',
          message: 'Codex could not receive the finalization reminder.',
          detail: `The hard deadline is unchanged; the latest durable checkpoint will be used. ${safeError(error)}`,
        });
      }
      return null;
    })();
    return active.finalizationPromise;
  }

  #enqueuePublic(active, event) {
    const safe = {
      kind: requireString(event?.kind ?? 'ACTIVITY', 'event kind', { min: 2, max: 40 }).toUpperCase(),
      level: ['info', 'warning', 'error'].includes(event?.level) ? event.level : 'info',
      message: sanitizePublicText(event?.message ?? 'Provider activity.'),
      detail: event?.detail === null || event?.detail === undefined ? null : sanitizePublicText(event.detail),
      at: new Date().toISOString(),
    };
    active.publicQueue = active.publicQueue.then(async () => {
      const stored = await appendPublicEvent(active.attempt.id, safe);
      for (const listener of this.listeners.get(active.attempt.id) ?? []) listener(stored);
      return stored;
    });
    active.publicQueue.catch((error) => {
      if (!active.stopping) void active.handle?.stop().catch(() => {});
      console.error(`Public event persistence failed: ${safeError(error)}`);
    });
    return active.publicQueue;
  }
}

function safeError(error) {
  return sanitizePublicText(error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export function requireUsefulRunMinutes(minutes) {
  if (Number.isFinite(minutes) && minutes >= MIN_USEFUL_RUN_MINUTES) return minutes;
  throw new HttpError(
    409,
    `At least ${MIN_USEFUL_RUN_MINUTES} safe minutes are required to research and preserve a durable contribution. No Codex research run was started.`,
    'insufficient_safe_time',
  );
}

export function finalizationDelayMs(deadlineMs, nowMs = Date.now()) {
  return deadlineMs - nowMs - FINALIZATION_RESERVE_MINUTES * 60_000;
}
