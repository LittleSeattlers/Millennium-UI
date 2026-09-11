import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  LocalCodexClient,
  LocalCompanionError,
  prepareConnectorLaunch,
  type AttemptRecord,
  type CodexEffort,
  type CodexModel,
  type CodexProvider,
  type ConnectorLaunch,
  type QuotaEstimate,
  type QuotaWindowEstimate,
  type ResearchFrontier,
  type ResearchMode,
  type ResearchTask,
  type RiskMode,
  type RunnerEvent,
} from './local-codex';
import { recommendCodexConfiguration } from './model-recommendation';
import type { Problem, Route } from './problems';

const minimumUsefulRunMinutes = 15;
const adaptiveSliceMinutes = minimumUsefulRunMinutes;
const adaptiveSlicePrefix = 'auto.slice.v1.';
const terminalStatuses = new Set(['completed', 'interrupted', 'aborted', 'failed']);
const pendingConnectorKey = 'millennium.connector.pending.v1';
const effortLabels: Record<CodexEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
};
const fallbackModel: CodexModel = {
  id: 'default',
  model: 'default',
  displayName: 'Local default',
  description: 'The model configured by this local Codex installation.',
  isDefault: true,
  defaultReasoningEffort: 'high',
  supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
};
const manualResearchModes: Array<{ id: Exclude<ResearchMode, 'recommended'>; label: string; note: string }> = [
  { id: 'frontier', label: 'Browse frontier', note: 'Open dependency tree' },
  { id: 'explore', label: 'Explore new', note: 'Open another path' },
  { id: 'verify', label: 'Verify result', note: 'Challenge prior work' },
];

type BusyAction = 'pair' | 'refresh' | 'start' | 'checkpoint' | 'stop' | 'publish' | 'disconnect' | null;
type ModelSelectionMode = 'auto' | 'manual';
type AllowanceSelectionMode = 'automatic' | 'manual';
type HostedCoordination = { ready: boolean; syncedAt?: string | null; error?: string | null } | null;
type AutomaticRunPlan = {
  provider: CodexProvider;
  coordination: NonNullable<HostedCoordination>;
  estimate: QuotaEstimate;
  frontier: ResearchFrontier;
  task: ResearchTask;
  model: CodexModel;
  effort: CodexEffort;
  safeMinutes: number;
  requestedMinutes: number;
};

class AutomaticRunStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutomaticRunStop';
  }
}

export function LocalResearchConsole({ problem, route }: { problem: Problem; route: Route }) {
  const connectInFlight = useRef(false);
  const startInFlight = useRef(false);
  const automaticRunRequested = useRef(false);
  const automaticRunInFlight = useRef(false);
  const [launchTicket, setLaunchTicket] = useState<ConnectorLaunch | null>(null);
  const [client, setClient] = useState<LocalCodexClient | null>(null);
  const [sessionExpiresAt, setSessionExpiresAt] = useState<string | null>(null);
  const [provider, setProvider] = useState<CodexProvider | null>(null);
  const [coordination, setCoordination] = useState<HostedCoordination>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [allowanceSelectionMode, setAllowanceSelectionMode] = useState<AllowanceSelectionMode>('automatic');
  const [manualRiskMode, setManualRiskMode] = useState<RiskMode>('balanced');
  const [modelSelectionMode, setModelSelectionMode] = useState<ModelSelectionMode>('auto');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<CodexEffort>('high');
  const [estimate, setEstimate] = useState<QuotaEstimate | null>(null);
  const [lastQuotaWindows, setLastQuotaWindows] = useState<QuotaWindowEstimate[]>([]);
  const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null);
  const [researchMode, setResearchMode] = useState<ResearchMode>('recommended');
  const [frontier, setFrontier] = useState<ResearchFrontier | null>(null);
  const [frontierLoading, setFrontierLoading] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [newDirection, setNewDirection] = useState('');
  const [activeAttempt, setActiveAttempt] = useState<AttemptRecord | null>(null);
  const [approvedObjective, setApprovedObjective] = useState<string | null>(null);
  const [events, setEvents] = useState<RunnerEvent[]>([]);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [automaticRunActive, setAutomaticRunActive] = useState(false);
  const [automaticRunCompleted, setAutomaticRunCompleted] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const riskMode: RiskMode = allowanceSelectionMode === 'automatic' ? 'balanced' : manualRiskMode;
  const fullyAutomatic = researchMode === 'recommended'
    && allowanceSelectionMode === 'automatic'
    && modelSelectionMode === 'auto';
  const isRunning = Boolean(activeAttempt && !terminalStatuses.has(activeAttempt.status));
  const availableModels = useMemo(() => {
    if (provider?.models?.length) return provider.models;
    return provider?.ready ? [fallbackModel] : [];
  }, [provider]);
  const accountModels = useMemo(() => provider?.models ?? [], [provider?.models]);
  const selectedModel = useMemo(
    () => availableModels.find((candidate) => candidate.model === model) ?? null,
    [availableModels, model],
  );
  const effortOptions = selectedModel?.supportedReasoningEfforts?.length
    ? selectedModel.supportedReasoningEfforts
    : fallbackModel.supportedReasoningEfforts;
  const safeMinutes = useMemo(() => {
    const safe = Math.max(0, Math.floor(estimate?.allowedMinutes ?? 0));
    const expires = Date.parse(sessionExpiresAt ?? '');
    const sessionMinutes = Number.isFinite(expires)
      ? Math.max(0, Math.floor((expires - now - 2 * 60_000) / 60_000))
      : 0;
    return Math.min(safe, sessionMinutes);
  }, [estimate, now, sessionExpiresAt]);
  const selectedTask = useMemo(
    () => frontier?.tasks.find((task) => task.id === selectedTaskId) ?? null,
    [frontier, selectedTaskId],
  );
  const automaticTask = useMemo(
    () => frontier?.tasks.find((task) => task.id === frontier.recommendedTaskId) ?? null,
    [frontier],
  );
  const taskDependenciesReady = !selectedTask || researchTaskDependenciesReady(selectedTask);
  const estimatedRunMinutes = selectedTask ? researchTaskEstimatedMinutes(selectedTask) : 0;
  const taskFitsAllowance = !selectedTask || estimatedRunMinutes <= safeMinutes;
  const runMinutes = researchMode === 'explore'
    ? safeMinutes
    : taskFitsAllowance && selectedTask
      ? Math.min(selectedTask.suggestedMinutes, safeMinutes)
      : 0;
  const quotaRemainingPercent = useMemo(() => {
    const values = (estimate?.windows ?? [])
      .map((window) => window.remainingPercent)
      .filter((value): value is number => Number.isFinite(value));
    return values.length > 0 ? Math.min(...values) : null;
  }, [estimate?.windows]);
  const autoRecommendation = useMemo(() => recommendCodexConfiguration({
    models: accountModels,
    defaultModel: provider?.defaultModel,
    researchMode,
    taskKind: selectedTask?.kind,
    safeMinutes: runMinutes || safeMinutes,
    quotaRemainingPercent,
  }), [accountModels, provider?.defaultModel, quotaRemainingPercent, researchMode, runMinutes, safeMinutes, selectedTask?.kind]);
  const effectiveModel = modelSelectionMode === 'auto' ? autoRecommendation?.model ?? null : selectedModel;
  const effectiveEffort = modelSelectionMode === 'auto'
    ? autoRecommendation?.effort ?? null
    : selectedModel?.supportedReasoningEfforts.includes(effort) ? effort : null;
  const objective = useMemo(
    () => researchMode === 'explore'
      ? explorationObjective(newDirection)
      : selectedTask?.objective ?? '',
    [newDirection, researchMode, selectedTask],
  );
  const selectionReady = researchMode === 'explore'
    ? safeMinutes >= minimumUsefulRunMinutes
      && newDirection.trim().replace(/\s+/g, ' ').length >= 20
    : selectedTask !== null
      && researchTaskSelectable(selectedTask, safeMinutes)
      && (researchMode !== 'verify' || selectedTask.kind === 'review')
      && (researchMode !== 'frontier' || selectedTask.kind !== 'review')
      && taskDependenciesReady
      && taskFitsAllowance;
  const activeAttemptId = activeAttempt?.id ?? null;
  const activeAttemptStatus = activeAttempt?.status ?? null;
  const activePublicationStatus = activeAttempt?.publication?.status ?? null;
  const terminalResult = activeAttempt && terminalStatuses.has(activeAttempt.status)
    ? describeTerminalResult(activeAttempt)
    : null;
  const usefulMinuteShortfall = Math.max(0, minimumUsefulRunMinutes - safeMinutes);
  const usefulAllowanceReady = estimate?.status === 'ready' && usefulMinuteShortfall === 0;
  const usefulAllowanceMessage = estimate?.status === 'ready'
    ? usefulAllowanceReady
      ? `${safeMinutes} safe minute${safeMinutes === 1 ? '' : 's'} available.${estimate.calibration ? ' This is a monitored calibration run for the selected plan and model.' : ''}`
      : `${safeMinutes} safe minute${safeMinutes === 1 ? '' : 's'} ${safeMinutes === 1 ? 'is' : 'are'} available. The shortest useful research run requires ${minimumUsefulRunMinutes} minutes (${usefulMinuteShortfall} more minute${usefulMinuteShortfall === 1 ? '' : 's'}). No Codex research run will start.`
    : estimate?.reason ?? 'Reading the current Codex allowance before selecting useful work.';
  const automaticFrontierSummary = !client
    ? 'Connect Codex to load the frontier'
    : !provider?.ready
      ? provider?.reason ?? 'Waiting for Codex readiness'
      : !coordination?.ready
        ? coordination?.error ?? 'GitHub knowledge sync is not ready'
        : estimate?.status !== 'ready'
          ? estimate?.reason ?? 'Reading the current allowance'
          : safeMinutes < minimumUsefulRunMinutes
            ? `Need ${usefulMinuteShortfall} more safe min`
            : isRunning
              ? 'A local research run is active'
              : frontierLoading
                ? 'Syncing shared frontier…'
                : !frontier
                  ? 'Shared frontier unavailable — refresh Codex'
                  : automaticTask?.title ?? 'No fitting task available';
  const activeModelName = activeAttempt?.model
    ? availableModels.find((candidate) => candidate.model === activeAttempt.model)?.displayName ?? activeAttempt.model
    : null;

  const connect = useCallback(async (ticket: ConnectorLaunch) => {
    if (connectInFlight.current) return;
    let pairedSession: Awaited<ReturnType<typeof LocalCodexClient.pairLaunchedConnector>> | null = null;
    connectInFlight.current = true;
    setBusy('pair');
    setError(null);
    setProvider(null);
    setCoordination(null);
    setLastQuotaWindows([]);
    setActiveAttempt(null);
    setNotice('Local approval received. Finishing the connection…');
    try {
      const paired = await LocalCodexClient.pairLaunchedConnector(ticket);
      pairedSession = paired;
      setClient(paired.client);
      setSessionExpiresAt(paired.expiresAt);
      setNow(Date.now());
      setNotice('Local companion paired. Reading your available models and current Codex allowance…');
      const state = await retryTransientLocalRequest(() => paired.client.state());
      const refreshed = await retryTransientLocalRequest(() => paired.client.refresh());
      const refreshedState = await retryTransientLocalRequest(() => paired.client.state());
      setProvider(refreshed);
      setCoordination(refreshedState.health.coordination ?? null);
      setActiveAttempt(refreshedState.activeAttempt ?? state.activeAttempt);
      setApprovedObjective(null);
      setEvents([]);
      if (!refreshed?.ready) {
        setNotice(null);
        setError(refreshed?.reason ?? 'Codex is not ready. Check your ChatGPT sign-in, then refresh.');
      } else if (!refreshedState.health.coordination?.ready) {
        setNotice(null);
        setError(refreshedState.health.coordination?.error ?? 'GitHub knowledge sync is not ready. Check gh auth and your network connection, then refresh.');
      } else {
        setError(null);
        setNotice('Codex is connected. Review the estimate and objective before starting work.');
      }
    } catch (reason) {
      const unauthorized = reason instanceof LocalCompanionError && reason.status === 401;
      if (!pairedSession || unauthorized) {
        setClient(null);
        setSessionExpiresAt(null);
        setNotice(null);
      } else {
        setClient(pairedSession.client);
        setSessionExpiresAt(pairedSession.expiresAt);
        setNotice('The local session is paired. Click Refresh Codex to retry the readiness check.');
      }
      setProvider(null);
      setCoordination(null);
      setError(messageFrom(reason));
    } finally {
      clearPendingConnectorLaunch();
      connectInFlight.current = false;
      setBusy(null);
      setLaunchTicket(null);
      void prepareConnectorLaunch().then(setLaunchTicket).catch(() => undefined);
    }
  }, []);

  useLayoutEffect(() => {
    setHeaderTarget(document.getElementById('header-codex-slot'));
  }, []);

  useEffect(() => {
    const currentIsAvailable = availableModels.some((candidate) => candidate.model === model);
    if (currentIsAvailable) return;
    const next = availableModels.find((candidate) => candidate.model === provider?.defaultModel)
      ?? availableModels.find((candidate) => candidate.isDefault)
      ?? availableModels[0];
    setModel(next?.model ?? '');
  }, [availableModels, model, provider?.defaultModel]);

  useEffect(() => {
    if (!selectedModel || selectedModel.supportedReasoningEfforts.includes(effort)) return;
    const next = selectedModel.supportedReasoningEfforts.includes(selectedModel.defaultReasoningEffort)
      ? selectedModel.defaultReasoningEffort
      : selectedModel.supportedReasoningEfforts[0];
    if (next) setEffort(next);
  }, [effort, selectedModel]);

  useEffect(() => {
    const decision = takeConnectorDecision();
    if (decision === 'denied') {
      clearPendingConnectorLaunch();
      setError('The local connector approval was cancelled.');
    } else {
      const pending = readPendingConnectorLaunch();
      if (pending) {
        setLaunchTicket(pending);
        void connect(pending);
        return undefined;
      }
      if (decision === 'approved') {
        setError('The connector was approved, but this tab lost its temporary pairing state. Click Connect and approve it once more.');
      }
    }
    let cancelled = false;
    void prepareConnectorLaunch()
      .then((ticket) => {
        if (!cancelled) setLaunchTicket(ticket);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(messageFrom(reason));
      });
    return () => { cancelled = true; };
  }, [connect]);

  useEffect(() => {
    if (isRunning) return;
    setResearchMode('recommended');
    setFrontier(null);
    setSelectedTaskId(null);
    setNewDirection('');
  }, [isRunning, problem.uiSlug, route.id]);

  useEffect(() => {
    automaticRunRequested.current = false;
    setAutomaticRunActive(false);
  }, [problem.uiSlug, route.id]);

  useEffect(() => () => {
    automaticRunRequested.current = false;
  }, []);

  useEffect(() => {
    if (!client) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), isRunning ? 1000 : 30_000);
    return () => window.clearInterval(timer);
  }, [client, isRunning]);

  useEffect(() => {
    if (!client || !provider?.ready) {
      setEstimate(null);
      return undefined;
    }
    let cancelled = false;
    setEstimate(null);
    retryTransientLocalRequest(() => client.estimate(riskMode, effectiveModel?.model))
      .then((value) => {
        if (!cancelled) {
          setEstimate(value);
          setLastQuotaWindows(value.windows ?? []);
        }
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setLastQuotaWindows([]);
        if (reason instanceof LocalCompanionError && reason.status === 401) {
          setClient(null);
          setProvider(null);
          setSessionExpiresAt(null);
          setError('The local session expired. Click Connect to pair this tab again.');
        } else setError(messageFrom(reason));
      });
    return () => { cancelled = true; };
  }, [client, effectiveModel?.model, provider?.ready, riskMode]);

  useEffect(() => {
    if (!client || !provider?.ready || !coordination?.ready
      || estimate?.status !== 'ready' || safeMinutes < minimumUsefulRunMinutes || isRunning) {
      if (!isRunning) setFrontier(null);
      setFrontierLoading(false);
      return undefined;
    }
    let cancelled = false;
    setFrontierLoading(true);
    retryTransientLocalRequest(() => client.frontier(problem.uiSlug, route.id, safeMinutes))
      .then((value) => {
        if (!cancelled) setFrontier(value);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        if (reason instanceof LocalCompanionError && reason.status === 401) {
          setClient(null);
          setProvider(null);
          setSessionExpiresAt(null);
          setError('The local session expired. Click Connect to pair this tab again.');
        } else setError(messageFrom(reason));
      })
      .finally(() => {
        if (!cancelled) setFrontierLoading(false);
      });
    return () => { cancelled = true; };
  }, [
    client,
    coordination?.ready,
    estimate?.status,
    isRunning,
    problem.uiSlug,
    provider?.ready,
    route.id,
    safeMinutes,
  ]);

  useEffect(() => {
    if (!frontier || isRunning) return;
    const isAvailable = (task: ResearchTask | undefined) => Boolean(
      task && researchTaskSelectable(task, safeMinutes),
    );
    if (researchMode === 'explore') {
      setSelectedTaskId(null);
      return;
    }
    if (researchMode === 'recommended') {
      setSelectedTaskId(frontier.recommendedTaskId);
      return;
    }
    const current = frontier.tasks.find((task) => task.id === selectedTaskId);
    const wantsReview = researchMode === 'verify';
    if (isAvailable(current) && (current?.kind === 'review') === wantsReview) return;
    const next = frontier.tasks.find((task) => task.status === 'available'
      && researchTaskDependenciesReady(task)
      && researchTaskEstimatedMinutes(task) <= safeMinutes
      && (task.kind === 'review') === wantsReview);
    setSelectedTaskId(next?.id ?? null);
  }, [frontier, isRunning, researchMode, safeMinutes, selectedTaskId]);

  useEffect(() => {
    const publicationPending = terminalStatuses.has(activeAttemptStatus ?? '') && activePublicationStatus === 'claimed';
    if (!client || !activeAttemptId || !activeAttemptStatus
      || (terminalStatuses.has(activeAttemptStatus) && !publicationPending)) return undefined;
    const controller = new AbortController();
    const poll = window.setInterval(() => {
      client.getAttempt(activeAttemptId)
        .then(setActiveAttempt)
        .catch((reason: unknown) => {
          if (reason instanceof LocalCompanionError && reason.status === 401) {
            setClient(null);
            setProvider(null);
            setSessionExpiresAt(null);
            setError('The local session expired. Click Connect to pair this tab again.');
          } else setError(messageFrom(reason));
        });
    }, 2000);
    void client.streamEvents(
      activeAttemptId,
      0,
      (event) => setEvents((current) => {
        if (current.some((item) => item.seq === event.seq)) return current;
        return [...current, event].sort((left, right) => left.seq - right.seq).slice(-80);
      }),
      controller.signal,
    ).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      if (reason instanceof LocalCompanionError && reason.status === 401) {
        setClient(null);
        setProvider(null);
        setSessionExpiresAt(null);
        setError('The local session expired. Click Connect to pair this tab again.');
      } else setError(messageFrom(reason));
    });
    return () => {
      controller.abort();
      window.clearInterval(poll);
    };
  }, [activeAttemptId, activeAttemptStatus, activePublicationStatus, client]);

  function handleClientActionFailure(reason: unknown) {
    if (reason instanceof LocalCompanionError && reason.status === 401) {
      setClient(null);
      setSessionExpiresAt(null);
      setProvider(null);
      setCoordination(null);
      setEstimate(null);
      setLastQuotaWindows([]);
      setFrontier(null);
      setNotice(null);
      setError('The local session expired. Connect again to resume local controls.');
      return;
    }
    setError(messageFrom(reason));
  }

  async function refreshCodex() {
    if (!client) return;
    setBusy('refresh');
    setError(null);
    try {
      const refreshed = await retryTransientLocalRequest(() => client.refresh());
      setProvider(refreshed);
      const refreshedState = await retryTransientLocalRequest(() => client.state());
      setCoordination(refreshedState.health.coordination ?? null);
      setActiveAttempt(refreshedState.activeAttempt);
      if (refreshed?.ready && refreshedState.health.coordination?.ready) {
        const refreshedEstimate = await retryTransientLocalRequest(() => client.estimate(riskMode, effectiveModel?.model));
        setEstimate(refreshedEstimate);
        setLastQuotaWindows(refreshedEstimate.windows ?? []);
        setNotice('Codex allowance and the shared GitHub ledger were refreshed.');
      } else {
        setError(refreshed?.reason ?? refreshedState.health.coordination?.error ?? 'Codex or GitHub coordination is not ready.');
      }
    } catch (reason) {
      setLastQuotaWindows([]);
      handleClientActionFailure(reason);
    } finally {
      setBusy(null);
    }
  }

  async function startWork() {
    if (!client || !provider?.ready || !estimate || estimate.status !== 'ready'
      || !effectiveModel || !effectiveEffort || startInFlight.current) return;
    if (selectedTask && !taskDependenciesReady) {
      const blocked = Math.max(1, selectedTask.blockedDependencies?.length ?? selectedTask.dependencies.length);
      setError(`This task is waiting on ${blocked} unfinished prerequisite${blocked === 1 ? '' : 's'}.`);
      return;
    }
    if (selectedTask && !taskFitsAllowance) {
      setError(`This task needs about ${researchTaskEstimatedMinutes(selectedTask)} safe minutes, but only ${safeMinutes} are currently available.`);
      return;
    }
    if (safeMinutes < minimumUsefulRunMinutes || runMinutes < minimumUsefulRunMinutes) {
      setError(usefulAllowanceMessage);
      return;
    }
    if (!selectionReady || objective.trim().length < 20) {
      setError(researchMode === 'explore'
        ? 'Describe a distinct research direction in at least 20 characters.'
        : 'Choose an available task from the local research frontier.');
      return;
    }
    startInFlight.current = true;
    setBusy('start');
    setError(null);
    setNotice(null);
    setEvents([]);
    try {
      const attempt = await client.start({
        provider: 'codex',
        problemId: problem.uiSlug,
        direction: route.id,
        riskMode,
        requestedMinutes: runMinutes,
        model: effectiveModel.model,
        effort: effectiveEffort,
        objective: objective.trim(),
        taskMode: researchMode,
        taskId: selectedTask?.id,
        newDirection: researchMode === 'explore'
          ? newDirection.trim().replace(/\s+/g, ' ')
          : undefined,
      });
      setActiveAttempt(attempt);
      setApprovedObjective(objective.trim());
      setNow(Date.now());
      setNotice('Work started locally. A draft PR now claims the task; when Codex stops, only its validated contribution summary will be submitted.');
    } catch (reason) {
      handleClientActionFailure(reason);
    } finally {
      startInFlight.current = false;
      setBusy(null);
    }
  }

  async function startAutomaticRun() {
    if (!client || automaticRunInFlight.current || isRunning || busy !== null) return;
    automaticRunRequested.current = true;
    automaticRunInFlight.current = true;
    setAutomaticRunActive(true);
    setAutomaticRunCompleted(0);
    setResearchMode('recommended');
    setAllowanceSelectionMode('automatic');
    setModelSelectionMode('auto');
    setAdvancedOpen(false);
    setError(null);
    setNotice('Automatic queue started. Checking the latest quota and shared frontier before each task.');
    let completed = 0;
    try {
      while (automaticRunRequested.current) {
        setBusy('refresh');
        const plan = await prepareAutomaticRunPlan({
          client,
          problemId: problem.uiSlug,
          direction: route.id,
          sessionExpiresAt,
        });
        setProvider(plan.provider);
        setCoordination(plan.coordination);
        setEstimate(plan.estimate);
        setLastQuotaWindows(plan.estimate.windows ?? []);
        setFrontier(plan.frontier);
        setSelectedTaskId(plan.task.id);
        setModel(plan.model.model);
        setEffort(plan.effort);
        setNow(Date.now());
        if (!automaticRunRequested.current) break;

        setBusy('start');
        setEvents([]);
        const attempt = await client.start({
          provider: 'codex',
          problemId: problem.uiSlug,
          direction: route.id,
          riskMode: 'balanced',
          requestedMinutes: plan.requestedMinutes,
          model: plan.model.model,
          effort: plan.effort,
          objective: plan.task.objective,
          taskMode: 'recommended',
          taskId: plan.task.id,
        });
        setActiveAttempt(attempt);
        setApprovedObjective(plan.task.objective);
        setNow(Date.now());
        setBusy(null);
        setNotice(`Automatic task ${completed + 1} started. The next task will be selected only after this contribution passes validation.`);

        const finished = await waitForAutomaticAttempt(client, attempt.id, setActiveAttempt);
        setActiveAttempt(finished);
        if (!automaticRunRequested.current) {
          setNotice('Automatic continuation stopped. The current task reached a terminal state and no new task will start.');
          break;
        }
        if (!attemptCanContinueAutomaticRun(finished)) {
          throw new AutomaticRunStop(automaticRunFailureMessage(finished, completed));
        }
        completed += 1;
        setAutomaticRunCompleted(completed);
        setNotice(`Automatic task ${completed} produced a validated contribution. Refreshing quota and shared knowledge before continuing…`);
      }
    } catch (reason) {
      if (reason instanceof AutomaticRunStop) {
        setError(null);
        setNotice(reason.message);
      } else {
        handleClientActionFailure(reason);
      }
    } finally {
      automaticRunRequested.current = false;
      automaticRunInFlight.current = false;
      setAutomaticRunActive(false);
      setBusy(null);
    }
  }

  function stopAutomaticRun() {
    automaticRunRequested.current = false;
    setAutomaticRunActive(false);
    setNotice(isRunning
      ? 'Automatic continuation will stop after the current task finishes. The active task was not interrupted.'
      : 'Automatic continuation stopped. No new task will start.');
  }

  async function checkpointAndStop() {
    if (!client || !activeAttempt) return;
    automaticRunRequested.current = false;
    setAutomaticRunActive(false);
    setBusy('checkpoint');
    setError(null);
    try {
      setActiveAttempt(await client.checkpoint(activeAttempt.id, true));
      setNotice('Checkpoint saved and Codex stopped. The local artifact remains available for review.');
    } catch (reason) {
      handleClientActionFailure(reason);
    } finally {
      setBusy(null);
    }
  }

  async function stopWork() {
    if (!client || !activeAttempt) return;
    automaticRunRequested.current = false;
    setAutomaticRunActive(false);
    setBusy('stop');
    setError(null);
    try {
      setActiveAttempt(await client.stop(activeAttempt.id));
      setNotice('Stop requested. Files already written remain in the local attempt artifact.');
    } catch (reason) {
      handleClientActionFailure(reason);
    } finally {
      setBusy(null);
    }
  }

  async function retryPublication() {
    if (!client || !activeAttempt) return;
    setBusy('publish');
    setError(null);
    try {
      const updated = await client.retryPublication(activeAttempt.id);
      setActiveAttempt(updated);
      setNotice('The canonical contribution was resubmitted to GitHub.');
    } catch (reason) {
      handleClientActionFailure(reason);
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!client || busy !== null || isRunning) return;
    automaticRunRequested.current = false;
    setAutomaticRunActive(false);
    setBusy('disconnect');
    try {
      await client.revoke();
    } catch {
      // Clear the in-memory browser session even if the companion has stopped.
    } finally {
      setClient(null);
      setSessionExpiresAt(null);
      setProvider(null);
      setCoordination(null);
      setEstimate(null);
      setLastQuotaWindows([]);
      setFrontier(null);
      setSelectedTaskId(null);
      setResearchMode('recommended');
      setAllowanceSelectionMode('automatic');
      setManualRiskMode('balanced');
      setNewDirection('');
      setActiveAttempt(null);
      setApprovedObjective(null);
      setEvents([]);
      setNotice(null);
      setError(null);
      setBusy(null);
    }
  }

  function handleConnectorLaunch(event: MouseEvent<HTMLAnchorElement>) {
    const ticket = launchTicket;
    if (connectInFlight.current || !ticket) {
      event.preventDefault();
      return;
    }
    try {
      savePendingConnectorLaunch(ticket);
    } catch {
      event.preventDefault();
      setError('This browser could not preserve the temporary connector approval. Refresh and try again.');
    }
  }

  const elapsedSeconds = activeAttempt
    ? elapsedFor(activeAttempt, now)
    : 0;
  const budgetSeconds = Math.max(1, (activeAttempt?.allowedMinutes ?? 0) * 60);
  const progress = Math.min(100, Math.max(0, (elapsedSeconds / budgetSeconds) * 100));
  const catalogTasks = useMemo(
    () => frontier?.tasks.filter((task) => task.kind !== 'review') ?? [],
    [frontier],
  );
  const verificationTasks = useMemo(
    () => frontier?.tasks.filter((task) => task.kind === 'review') ?? [],
    [frontier],
  );
  const hasAvailableOversizedTask = frontier?.tasks.some((task) => task.status === 'available'
    && task.kind !== 'review'
    && researchTaskDependenciesReady(task)
    && researchTaskEstimatedMinutes(task) > safeMinutes) ?? false;
  const consoleProblemName = isRunning
    ? activeAttempt?.problemName ?? problem.name
    : problem.name;
  const consoleRouteLabel = isRunning
    ? activeAttempt?.routeLabel ?? route.label
    : route.label;
  const visibleQuotaWindows = estimate?.windows?.length
    ? estimate.windows
    : lastQuotaWindows;
  const headerQuotaMeters = quotaMeters(visibleQuotaWindows);
  const connectorReady = Boolean(provider?.ready && coordination?.ready);
  const connectorNeedsAttention = Boolean(
    client && ((provider && !provider.ready) || (coordination && !coordination.ready)),
  );
  const connectorState = isRunning
    ? 'RUNNING'
    : connectorReady
      ? 'CONNECTED'
      : connectorNeedsAttention
        ? 'ATTENTION'
      : client
        ? 'CHECKING'
        : 'DISCONNECTED';

  const headerControl = !client ? (
    <a
      aria-disabled={busy === 'pair' || !launchTicket}
      className="header-connect-action"
      href={launchTicket?.url}
      onClick={handleConnectorLaunch}
    >
      <span className="header-codex-dot" />
      <b>{busy === 'pair'
        ? 'Waiting for local Codex…'
        : launchTicket
          ? 'Connect to local Codex'
          : 'Preparing local Codex…'}</b>
    </a>
  ) : (
    <a
      aria-label={`Local Codex ${connectorState.toLowerCase()}. ${headerQuotaMeters.map((meter) => `${meter.longLabel}, ${formatAccessibleHeaderPercentage(meter.window?.remainingPercent)}`).join('. ')}.`}
      className={`header-codex-summary state-${connectorState.toLowerCase()}`}
      href="#local-codex"
    >
      <span className="header-codex-status">
        <i />
        <span><small>LOCAL CODEX</small><b>{connectorState}</b></span>
      </span>
      {headerQuotaMeters.map((meter) => (
        <span className="header-quota-meter" key={meter.key}>
          <small><span className="quota-label-long">{meter.label}</span><span className="quota-label-short">{meter.shortLabel}</span></small>
          <b>{formatHeaderPercentage(meter.window?.remainingPercent)}</b>
        </span>
      ))}
      <span className="header-codex-arrow" aria-hidden="true">↓</span>
    </a>
  );

  return (
    <>
      {headerTarget && createPortal(
        <div className="header-codex-control" aria-live="polite">{headerControl}</div>,
        headerTarget,
      )}
      <section className={`panel local-console${client ? ' connected' : ''}`} id="local-codex">
      <div className="local-console-heading">
        <div>
          <p className="eyebrow">LOCAL CODEX · {consoleProblemName.toUpperCase()}</p>
          <h2>{isRunning
            ? `Working on ${consoleRouteLabel}.`
            : client
              ? `${consoleRouteLabel} is ready for a bounded run.`
              : `Connect Codex for ${consoleProblemName}.`}</h2>
        </div>
        <div className="local-console-actions">
          <span className={`runner-state ${connectorReady ? 'ready' : client ? 'checking' : ''}`}>
            <i /> {connectorReady ? 'READY' : connectorNeedsAttention ? 'ATTENTION' : client ? 'CHECKING' : 'DISCONNECTED'}
          </span>
          {client && (
            <div className="connected-actions">
              <button disabled={busy !== null} onClick={() => void refreshCodex()} type="button">
                {busy === 'refresh' ? 'Refreshing…' : 'Refresh'}
              </button>
              <button disabled={busy !== null || isRunning} onClick={() => void disconnect()} type="button">
                {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </div>
          )}
        </div>
      </div>

      {!client ? (
        <div className="disconnected-console-note">
          <p>Connect from the top-right control to choose a research task and start work on this direction.</p>
          <details className="first-time-setup">
            <summary>First time on this computer?</summary>
            <div className="setup-guide">
              <p className="setup-intro">Run these steps in <b>Windows PowerShell</b> as your normal Windows user. Administrator mode is not required unless Windows asks for it.</p>
              <ol className="setup-steps">
                <li>
                  <div>
                    <strong>Install the Windows prerequisites</strong>
                    <small>These commands install Git, GitHub CLI, and the current Node.js LTS release.</small>
                    <div className="setup-command">
                      <span>WINDOWS POWERSHELL</span>
                      <code>winget install --id Git.Git --exact<br />winget install --id GitHub.cli --exact<br />winget install --id OpenJS.NodeJS.LTS --exact</code>
                    </div>
                  </div>
                </li>
                <li>
                  <div>
                    <strong>Close PowerShell, reopen it, then install pnpm</strong>
                    <small>Reopening PowerShell refreshes <code>PATH</code>. Millennium requires Node.js 22.13 or newer and pnpm 11.</small>
                    <div className="setup-command">
                      <span>INSTALL AND VERIFY</span>
                      <code>npm install --global pnpm@11.19.0<br />node --version<br />npm --version<br />pnpm --version<br />git --version<br />gh --version</code>
                    </div>
                  </div>
                </li>
                <li>
                  <div>
                    <strong>Download Millennium and its pinned dependencies</strong>
                    <div className="setup-command">
                      <span>PUBLIC REPOSITORY</span>
                      <code>git clone https://github.com/LittleSeattlers/Millennium-UI.git<br />Set-Location .\Millennium-UI<br />pnpm install</code>
                    </div>
                  </div>
                </li>
                <li>
                  <div>
                    <strong>Sign in to GitHub and Codex</strong>
                    <small>For GitHub, choose GitHub.com, HTTPS, and browser sign-in. For Codex, choose <b>Sign in with ChatGPT</b> so research uses your subscription—not an API key.</small>
                    <div className="setup-command">
                      <span>ONE-TIME ACCOUNT SIGN-IN</span>
                      <code>gh auth login<br />pnpm exec codex login<br />pnpm exec codex login status</code>
                    </div>
                  </div>
                </li>
                <li>
                  <div>
                    <strong>Install the background connector</strong>
                    <small>After this succeeds, close PowerShell, return here, and press <b>Connect to local Codex</b>.</small>
                    <div className="setup-command">
                      <span>FINAL STEP</span>
                      <code>pnpm connector:install</code>
                    </div>
                  </div>
                </li>
              </ol>
            </div>
            <small>The connector starts in the background when you sign in to Windows; no terminal needs to remain open.</small>
          </details>
        </div>
      ) : (
        <>
          {!isRunning && (
            <div className="research-composer">
              <div className="composer-controls">
                <div className="control-group run-configuration-control">
                  <span>RUN CONFIGURATION</span>
                  {!advancedOpen && (
                    <button
                      aria-pressed={fullyAutomatic}
                      className={`auto-run-choice${fullyAutomatic ? ' active' : ''}`}
                      onClick={() => {
                        setResearchMode('recommended');
                        setAllowanceSelectionMode('automatic');
                        setModelSelectionMode('auto');
                        setError(null);
                      }}
                      type="button"
                    >
                      <span className="auto-run-heading">
                        <b>Automatic</b>
                        <small>Chooses a useful shared-frontier task and configures the run. Nothing starts below {minimumUsefulRunMinutes} minutes.</small>
                      </span>
                      <span className="auto-run-summary">
                        <span>
                          <i>FRONTIER</i>
                          <strong>{automaticFrontierSummary}</strong>
                        </span>
                        <span>
                          <i>ALLOWANCE</i>
                          <strong>{estimate ? `Standard reserve · ${safeMinutes} safe min` : 'Reading allowance…'}</strong>
                        </span>
                        <span>
                          <i>CODEX</i>
                          <strong>
                            {autoRecommendation
                              ? `${autoRecommendation.model.displayName} · ${effortLabels[autoRecommendation.effort]}`
                              : 'Reading available models…'}
                          </strong>
                        </span>
                      </span>
                    </button>
                  )}
                  <details
                    className="advanced-run-settings"
                    onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
                    open={advancedOpen}
                  >
                    <summary>
                      Advanced settings
                      {!fullyAutomatic && <em>Manual override active</em>}
                    </summary>
                    <div className="advanced-run-body">
                      <div className="advanced-run-grid">
                        <section className="advanced-run-section">
                          <span>QUOTA RESERVE</span>
                          <label className={`manual-setting-choice${allowanceSelectionMode === 'manual' ? ' active' : ''}`}>
                            <input
                              checked={allowanceSelectionMode === 'manual'}
                              onChange={(event) => {
                                setAllowanceSelectionMode(event.target.checked ? 'manual' : 'automatic');
                                setError(null);
                              }}
                              type="checkbox"
                            />
                            <span>
                              <b>Customize reserve</b>
                              <small>Standard keeps 10% unless this override is enabled.</small>
                            </span>
                          </label>
                          <div className="segmented-control allowance-options">
                            {([
                              { id: 'protect', label: 'Protect quota', note: '15% reserve' },
                              { id: 'balanced', label: 'Standard', note: '10% reserve' },
                              { id: 'harvest', label: 'Use expiring quota', note: '5% reserve' },
                            ] as Array<{ id: RiskMode; label: string; note: string }>).map((mode) => (
                              <button
                                className={allowanceSelectionMode === 'manual' && manualRiskMode === mode.id ? 'active' : ''}
                                disabled={allowanceSelectionMode !== 'manual'}
                                key={mode.id}
                                onClick={() => {
                                  setManualRiskMode(mode.id);
                                  setError(null);
                                }}
                                type="button"
                              >
                                <b>{mode.label}</b>
                                <small>{mode.note}</small>
                              </button>
                            ))}
                          </div>
                        </section>
                        <section className="advanced-run-section">
                          <span>MODEL AND REASONING</span>
                          <label className={`manual-setting-choice${modelSelectionMode === 'manual' ? ' active' : ''}`}>
                            <input
                              checked={modelSelectionMode === 'manual'}
                              onChange={(event) => {
                                setModelSelectionMode(event.target.checked ? 'manual' : 'auto');
                                setError(null);
                              }}
                              type="checkbox"
                            />
                            <span>
                              <b>Customize model and effort</b>
                              <small>Pin this attempt to an exact available configuration.</small>
                            </span>
                          </label>
                          <div className="advanced-model-selects">
                            <label>
                              <span>MODEL</span>
                              <select
                                disabled={modelSelectionMode !== 'manual' || availableModels.length === 0}
                                onChange={(event) => setModel(event.target.value)}
                                title={selectedModel?.description}
                                value={model}
                              >
                                {availableModels.map((candidate) => (
                                  <option key={candidate.id} value={candidate.model}>
                                    {candidate.displayName}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              <span>REASONING EFFORT</span>
                              <select
                                disabled={modelSelectionMode !== 'manual'}
                                onChange={(event) => setEffort(event.target.value as CodexEffort)}
                                value={effort}
                              >
                                {effortOptions.map((option) => (
                                  <option key={option} value={option}>{effortLabels[option]}</option>
                                ))}
                              </select>
                            </label>
                          </div>
                        </section>
                      </div>
                      {!fullyAutomatic && (
                        <button
                          className="restore-automatic-action"
                          onClick={() => {
                            setResearchMode('recommended');
                            setAllowanceSelectionMode('automatic');
                            setModelSelectionMode('auto');
                            setAdvancedOpen(false);
                            setError(null);
                          }}
                          type="button"
                        >
                          Restore Automatic
                        </button>
                      )}
                      <div className="frontier-panel advanced-frontier-panel">
                <div className="frontier-heading">
                  <div>
                    <span>SHARED RESEARCH FRONTIER</span>
                    <b>Automatic chooses the best fitting task. Open a branch to follow its dependencies and successor work.</b>
                  </div>
                  {frontier && (
                    <div className="frontier-counts" aria-label="Local task states">
                      <span><b>{frontier.counts.available}</b> available</span>
                      <span><b>{frontier.counts.attempted}</b> attempted</span>
                      {frontier.counts.leased > 0 && <span><b>{frontier.counts.leased}</b> leased</span>}
                      {(frontier.counts.blocked ?? 0) > 0 && <span><b>{frontier.counts.blocked}</b> waiting</span>}
                    </div>
                  )}
                </div>
                <div className="research-mode-tabs" aria-label="Research task mode">
                  {manualResearchModes.map((mode) => (
                    <button
                      aria-pressed={researchMode === mode.id}
                      className={researchMode === mode.id ? 'active' : ''}
                      key={mode.id}
                      onClick={() => {
                        setResearchMode(mode.id);
                        setError(null);
                      }}
                      type="button"
                    >
                      <b>{mode.label}</b>
                      <small>{mode.note}</small>
                    </button>
                  ))}
                </div>

                <div className="frontier-content">
                  {frontierLoading && <p className="frontier-empty">Syncing trusted knowledge and active GitHub claims…</p>}

                  {!frontierLoading && researchMode === 'recommended' && (
                    !usefulAllowanceReady ? (
                      <p className="frontier-empty useful-allowance-empty">{usefulAllowanceMessage}</p>
                    ) : selectedTask ? (
                      <ResearchTaskCard safeMinutes={safeMinutes} selected task={selectedTask} />
                    ) : (
                      <p className="frontier-empty">
                        {hasAvailableOversizedTask
                          ? safeMinutes < adaptiveSliceMinutes
                            ? `No planned task fits the current ${safeMinutes}-minute safe allowance. Automatic preparatory slices start at ${adaptiveSliceMinutes} minutes so a run still has time to produce a durable result. `
                            : `No planned task fits the current ${safeMinutes}-minute safe allowance. The original task remains intact instead of being cut short. `
                          : 'No curated task is available for this route. '}
                        {safeMinutes >= minimumUsefulRunMinutes && <>Open <b>Explore new</b> to add a distinct direction that fits the available time.</>}
                      </p>
                    )
                  )}

                  {!frontierLoading && researchMode === 'frontier' && (
                    !usefulAllowanceReady ? (
                      <p className="frontier-empty useful-allowance-empty">{usefulAllowanceMessage}</p>
                    ) : catalogTasks.length > 0 ? (
                      <ResearchFrontierTree
                        onSelectTask={setSelectedTaskId}
                        recommendedTaskId={frontier?.recommendedTaskId ?? null}
                        safeMinutes={safeMinutes}
                        selectedTaskId={selectedTaskId}
                        tasks={catalogTasks}
                      />
                    ) : <p className="frontier-empty">No curated tasks are defined for this route yet.</p>
                  )}

                  {!frontierLoading && researchMode === 'verify' && (
                    !usefulAllowanceReady ? (
                      <p className="frontier-empty useful-allowance-empty">{usefulAllowanceMessage}</p>
                    ) : verificationTasks.length > 0 ? (
                      <div className="frontier-task-list">
                        {verificationTasks.map((task) => (
                          <button
                            className={`frontier-task-choice${selectedTaskId === task.id ? ' selected' : ''}`}
                            disabled={!researchTaskSelectable(task, safeMinutes)}
                            key={task.id}
                            onClick={() => setSelectedTaskId(task.id)}
                            title={researchTaskUnavailableReason(task, safeMinutes)}
                            type="button"
                          >
                            <ResearchTaskCard safeMinutes={safeMinutes} selected={selectedTaskId === task.id} task={task} />
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="frontier-empty">
                        No trusted completed result is waiting on this route. Verification tasks appear here without exposing result prose to the hosted page.
                      </p>
                    )
                  )}

                  {!frontierLoading && researchMode === 'explore' && (
                    !usefulAllowanceReady ? (
                      <p className="frontier-empty useful-allowance-empty">{usefulAllowanceMessage}</p>
                    ) : <label className="new-direction-field" htmlFor="new-research-direction">
                      <span>PROPOSE A DISTINCT DIRECTION</span>
                      <textarea
                        id="new-research-direction"
                        maxLength={360}
                        onChange={(event) => setNewDirection(event.target.value)}
                        placeholder="Describe a different mechanism, reduction, certificate, formalization, adversarial test, or other path. Codex will reduce it to the smallest falsifiable next step."
                        rows={3}
                        value={newDirection}
                      />
                      <small>
                        New directions receive a stable branch ID. A merged successor proposal becomes executable only after its source record is promoted through the reviewed trust registry.
                      </small>
                    </label>
                  )}
                </div>
                      </div>
                      <div className="objective-row">
                        <label htmlFor="research-objective">
                          <span>APPROVED TASK OBJECTIVE · {problem.name} / {route.label}</span>
                          <textarea
                            id="research-objective"
                            placeholder="Choose an available task or describe a new direction."
                            readOnly
                            rows={4}
                            value={objective}
                          />
                        </label>
                      </div>
                    </div>
                  </details>
                </div>
              </div>

              <div className="estimate-row">
                <div className={`allowance-card${estimate?.status === 'blocked' || (estimate?.status === 'ready' && !usefulAllowanceReady) ? ' blocked' : ''}`}>
                  <span>{allowanceSelectionMode === 'automatic' ? 'AUTOMATIC SAFE ALLOWANCE' : `${manualRiskMode.toUpperCase()} SAFE ALLOWANCE`}</span>
                  <strong>{estimate ? safeMinutes : '—'}<small> min</small></strong>
                  <p>{estimate?.reason ?? (provider?.ready ? 'Reading current Codex limits…' : provider?.reason ?? 'Codex sign-in has not been verified.')}</p>
                  {Boolean(estimate?.windows?.length) && (
                    <div className="quota-window-list">
                      {estimate?.windows?.map((window) => (
                        <span key={window.id ?? window.label}>
                          <b>{window.label}</b>
                          <em>{formatPercentageLeft(window.remainingPercent)}</em>
                          <small>{formatReset(window.resetsAt)}</small>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="start-column">
                  <div className="network-toggle hosted-safety">
                    <span><b>Local execution, public ledger</b><small>Research network access is disabled. Raw files stay local; one strict-schema JSON contribution is submitted through GitHub.</small></span>
                  </div>
                  <button
                    className="start-work-button"
                    disabled={automaticRunActive || busy !== null || !provider?.ready || !coordination?.ready || !effectiveModel || !effectiveEffort || estimate?.status !== 'ready' || safeMinutes < minimumUsefulRunMinutes || runMinutes < minimumUsefulRunMinutes || !selectionReady || objective.trim().length < 20}
                    onClick={() => void startWork()}
                    type="button"
                  >
                    {busy === 'start'
                      ? 'Claiming task & starting…'
                      : estimate?.status !== 'ready'
                        ? 'Allowance unavailable'
                        : safeMinutes < minimumUsefulRunMinutes
                          ? `Need ${usefulMinuteShortfall} more safe min`
                        : selectedTask && !taskFitsAllowance
                          ? `Needs ~${researchTaskEstimatedMinutes(selectedTask)} safe min`
                          : runMinutes < minimumUsefulRunMinutes
                            ? 'Choose a task'
                            : researchMode === 'explore'
                              ? `Start work · ${runMinutes} min`
                              : `Start work · ~${estimatedRunMinutes} min`}
                  </button>
                  <button
                    className={`automatic-queue-button${automaticRunActive ? ' active' : ''}`}
                    disabled={!automaticRunActive && (busy !== null || !provider?.ready || !coordination?.ready || estimate?.status !== 'ready' || safeMinutes < minimumUsefulRunMinutes || !automaticTask)}
                    onClick={automaticRunActive ? stopAutomaticRun : () => void startAutomaticRun()}
                    type="button"
                  >
                    {automaticRunActive
                      ? `Stop automatic queue${automaticRunCompleted > 0 ? ` · ${automaticRunCompleted} completed` : ''}`
                      : 'Run automatic tasks until quota is low'}
                  </button>
                  <small>Where matching completed runs exist, the displayed time is a conservative measured estimate. A run may end early and can use up to the lesser of its task ceiling and the current safe allowance. Runs below {minimumUsefulRunMinutes} minutes are not started. If an estimated run does not fit, the connector offers a separate {adaptiveSliceMinutes}-minute preparatory task. The final 4 minutes are reserved for a durable result. Keep this page open for the automatic queue to launch subsequent tasks; stopping the queue does not interrupt its current task.</small>
                </div>
              </div>
            </div>
          )}

          {activeAttempt && (
            <div className="live-attempt" aria-live="polite">
              <div className="live-heading">
                <div>
                  <p className="eyebrow">{terminalStatuses.has(activeAttempt.status) ? 'LOCAL RESULT' : 'LIVE LOCAL ATTEMPT'}</p>
                  <h3>{activeAttempt.researchTask?.title ?? `${activeAttempt.problemName ?? problem.name} · ${activeAttempt.routeLabel ?? route.label}`}</h3>
                  {activeModelName && <small className="active-model">{activeModelName} · {effortLabels[(activeAttempt.effort as CodexEffort) ?? effort] ?? activeAttempt.effort}</small>}
                </div>
                <span className={`attempt-status status-${terminalResult?.tone ?? 'running'}`}>
                  {terminalResult?.label ?? activeAttempt.status.toUpperCase()}
                </span>
              </div>
              {terminalResult && <p className={`terminal-result-note tone-${terminalResult.tone}`}>{terminalResult.detail}</p>}
              <div className="run-clock">
                <strong>{formatClock(elapsedSeconds)}</strong>
                <span>of {activeAttempt.allowedMinutes ?? 0} minutes</span>
                <progress aria-label="Attempt elapsed time" max="100" value={progress} />
              </div>
              <p className="active-objective">
                {activeAttempt.objective ?? approvedObjective ?? 'The selected objective is retained only in the private local artifact.'}
              </p>
              {activeAttempt.publication && (
                <div className={`publication-status publication-${activeAttempt.publication.status}`}>
                  <span>SHARED CONTRIBUTION</span>
                  <b>{publicationLabel(activeAttempt)}</b>
                  {activeAttempt.publication.prUrl && (
                    <a href={activeAttempt.publication.prUrl} rel="noreferrer" target="_blank">
                      Open pull request{activeAttempt.publication.prNumber ? ` #${activeAttempt.publication.prNumber}` : ''}
                    </a>
                  )}
                  {(activeAttempt.publication.error || activeAttempt.publication.warning) && (
                    <small>{activeAttempt.publication.error ?? activeAttempt.publication.warning}</small>
                  )}
                  {activeAttempt.publication.status === 'failed' && (
                    <button disabled={busy !== null} onClick={() => void retryPublication()} type="button">
                      {busy === 'publish' ? 'Retrying…' : 'Retry contribution'}
                    </button>
                  )}
                </div>
              )}
              <div className="event-stream">
                {events.length === 0 ? (
                  <p>Waiting for the first persisted Codex event…</p>
                ) : events.map((event) => (
                  <div className={`event-row level-${event.level ?? 'info'}`} key={event.seq}>
                    <span>{String(event.seq).padStart(3, '0')}</span>
                    <b>{event.kind}</b>
                    <p>{event.message}{event.detail ? <small>{event.detail}</small> : null}</p>
                  </div>
                ))}
              </div>
              {isRunning && (
                <div className="attempt-actions">
                  <button disabled={busy !== null} onClick={() => void checkpointAndStop()} type="button">
                    {busy === 'checkpoint' ? 'Saving…' : 'Checkpoint & stop'}
                  </button>
                  <button disabled={busy !== null} onClick={() => void stopWork()} type="button">
                    {busy === 'stop' ? 'Stopping…' : 'Stop now'}
                  </button>
                  {automaticRunActive && (
                    <button className="stop-automatic-action" onClick={stopAutomaticRun} type="button">
                      Stop after this task{automaticRunCompleted > 0 ? ` · ${automaticRunCompleted} completed` : ''}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {(notice || error) && (
        <p className={`runner-notice${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>
          <span /> {error ?? notice}
        </p>
      )}
      <p className="local-boundary-note">
        This console talks only to <code>127.0.0.1</code>. The connector reads merged contribution summaries privately for Codex context; the hosted page receives readiness, available model names, sanitized window percentages, safe minutes, task text, opaque task states, and status-only events—not raw research files, commands, account details, provider events, or prior-attempt prose.
      </p>
      </section>
    </>
  );
}

async function prepareAutomaticRunPlan({
  client,
  problemId,
  direction,
  sessionExpiresAt,
}: {
  client: LocalCodexClient;
  problemId: string;
  direction: string;
  sessionExpiresAt: string | null;
}): Promise<AutomaticRunPlan> {
  const provider = await retryTransientLocalRequest(() => client.refresh());
  const state = await retryTransientLocalRequest(() => client.state());
  const coordination = state.health.coordination ?? { ready: false, error: 'GitHub knowledge sync is not ready.' };
  if (!provider?.ready) {
    throw new AutomaticRunStop(provider?.reason ?? 'Automatic queue stopped because Codex is not ready.');
  }
  if (!coordination.ready) {
    throw new AutomaticRunStop(coordination.error ?? 'Automatic queue stopped because GitHub knowledge sync is not ready.');
  }
  const models = provider.models?.length ? provider.models : [fallbackModel];
  let recommendation = recommendCodexConfiguration({
    models,
    defaultModel: provider.defaultModel,
    researchMode: 'recommended',
    taskKind: null,
    safeMinutes: 120,
    quotaRemainingPercent: null,
  });
  if (!recommendation) {
    throw new AutomaticRunStop('Automatic queue stopped because no usable Codex model is available.');
  }

  for (let pass = 0; pass < 3; pass += 1) {
    const estimate = await retryTransientLocalRequest(() => client.estimate('balanced', recommendation?.model.model));
    const safeMinutes = safeMinutesForSession(estimate, sessionExpiresAt);
    if (estimate.status !== 'ready' || safeMinutes < minimumUsefulRunMinutes) {
      throw new AutomaticRunStop(`Automatic queue stopped before starting another task. ${estimate.reason}`);
    }
    const frontier = await retryTransientLocalRequest(() => client.frontier(problemId, direction, safeMinutes));
    const task = frontier.tasks.find((candidate) => candidate.id === frontier.recommendedTaskId) ?? null;
    if (!task || !researchTaskSelectable(task, safeMinutes)) {
      throw new AutomaticRunStop(`Automatic queue stopped: no automatic task fits the current ${safeMinutes}-minute safe allowance.`);
    }
    const finalRecommendation = recommendCodexConfiguration({
      models,
      defaultModel: provider.defaultModel,
      researchMode: 'recommended',
      taskKind: task.kind,
      safeMinutes: Math.min(task.suggestedMinutes, safeMinutes),
      quotaRemainingPercent: minimumRemainingPercentage(estimate.windows ?? []),
    });
    if (!finalRecommendation) {
      throw new AutomaticRunStop('Automatic queue stopped because no usable model and reasoning configuration is available.');
    }
    if (finalRecommendation.model.model !== recommendation.model.model) {
      recommendation = finalRecommendation;
      continue;
    }
    return {
      provider,
      coordination,
      estimate,
      frontier,
      task,
      model: finalRecommendation.model,
      effort: finalRecommendation.effort,
      safeMinutes,
      requestedMinutes: Math.min(task.suggestedMinutes, safeMinutes),
    };
  }
  throw new AutomaticRunStop('Automatic queue stopped because the recommended Codex configuration did not stabilize.');
}

async function waitForAutomaticAttempt(
  client: LocalCodexClient,
  attemptId: string,
  onUpdate: (attempt: AttemptRecord) => void,
) {
  for (;;) {
    await waitMilliseconds(2_000);
    const attempt = await retryTransientLocalRequest(() => client.getAttempt(attemptId));
    onUpdate(attempt);
    const terminal = terminalStatuses.has(attempt.status);
    const publicationFinished = attempt.publication?.status !== 'claimed';
    if (terminal && publicationFinished) return attempt;
  }
}

function attemptCanContinueAutomaticRun(attempt: AttemptRecord) {
  return attempt.status === 'completed'
    && attempt.terminalDisposition === 'completed'
    && attempt.researchValue?.status === 'accepted'
    && attempt.publication?.status === 'submitted'
    && attempt.publication.contributionSource === 'structured-proposal';
}

function automaticRunFailureMessage(attempt: AttemptRecord, completed: number) {
  const prefix = `Automatic queue stopped after ${completed} validated task${completed === 1 ? '' : 's'}`;
  const reason = attempt.publication?.error
    ?? attempt.publication?.warning
    ?? attempt.researchValue?.reason
    ?? `the latest task ended as ${attempt.terminalDisposition ?? attempt.status}`;
  return `${prefix}: ${reason}. No new task was started.`;
}

function safeMinutesForSession(estimate: QuotaEstimate, sessionExpiresAt: string | null) {
  const quotaMinutes = Math.max(0, Math.floor(estimate.allowedMinutes ?? 0));
  const expires = Date.parse(sessionExpiresAt ?? '');
  const sessionMinutes = Number.isFinite(expires)
    ? Math.max(0, Math.floor((expires - Date.now() - 2 * 60_000) / 60_000))
    : 0;
  return Math.min(quotaMinutes, sessionMinutes);
}

function minimumRemainingPercentage(windows: QuotaWindowEstimate[]) {
  const values = windows
    .map((window) => window.remainingPercent)
    .filter((value): value is number => Number.isFinite(value));
  return values.length > 0 ? Math.min(...values) : null;
}

function waitMilliseconds(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

function ResearchTaskCard({
  task,
  selected,
  safeMinutes,
}: {
  task: ResearchTask;
  selected: boolean;
  safeMinutes?: number;
}) {
  const dependenciesReady = researchTaskDependenciesReady(task);
  const blockedCount = Math.max(1, task.blockedDependencies?.length ?? task.dependencies.length);
  const needsMoreTime = task.status === 'available'
    && dependenciesReady
    && Number.isFinite(safeMinutes)
    && researchTaskEstimatedMinutes(task) > Number(safeMinutes);
  const isAdaptiveSlice = task.budgetBasis === 'adaptive-slice' || task.id.startsWith(adaptiveSlicePrefix);
  return (
    <span className="research-task-card">
      <span className="task-card-meta">
        <b>{isAdaptiveSlice ? 'Preparatory slice' : formatTaskKind(task.kind)}</b>
        <i>{task.branchId.replaceAll('-', ' ')}</i>
        <em className={`task-state ${!dependenciesReady ? 'state-blocked' : needsMoreTime ? 'state-time' : `state-${task.status}`}`}>
          {!dependenciesReady
            ? `waiting on ${blockedCount}`
            : needsMoreTime
            ? `needs ~${researchTaskEstimatedMinutes(task)} min`
            : selected && task.status === 'available' ? 'selected' : task.status}
        </em>
      </span>
      <strong>{task.title}</strong>
      <p>{task.rationale}</p>
      <small>{researchTaskBudgetLabel(task)} · Evidence, falsifier, and next step required</small>
    </span>
  );
}

type ResearchBranchTree = {
  id: string;
  label: string;
  tasks: ResearchTask[];
  roots: ResearchTask[];
  children: Map<string, ResearchTask[]>;
};

function ResearchFrontierTree({
  tasks,
  selectedTaskId,
  recommendedTaskId,
  safeMinutes,
  onSelectTask,
}: {
  tasks: ResearchTask[];
  selectedTaskId: string | null;
  recommendedTaskId: string | null;
  safeMinutes: number;
  onSelectTask: (taskId: string) => void;
}) {
  const branches = useMemo(
    () => buildResearchBranchTrees(tasks, recommendedTaskId, safeMinutes),
    [recommendedTaskId, safeMinutes, tasks],
  );
  const taskById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );
  const initialFocus = taskById.get(selectedTaskId ?? '') ?? taskById.get(recommendedTaskId ?? '');
  const [expandedBranches, setExpandedBranches] = useState<Set<string>>(
    () => new Set(initialFocus ? [initialFocus.branchId] : branches[0] ? [branches[0].id] : []),
  );
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(() => {
    const ancestors = new Set<string>();
    const seen = new Set<string>();
    let ancestor = initialFocus?.parentTaskId ? taskById.get(initialFocus.parentTaskId) : null;
    while (ancestor && !seen.has(ancestor.id)) {
      seen.add(ancestor.id);
      ancestors.add(ancestor.id);
      ancestor = ancestor.parentTaskId ? taskById.get(ancestor.parentTaskId) : null;
    }
    return ancestors;
  });

  const allExpanded = branches.length > 0
    && branches.every((branch) => expandedBranches.has(branch.id))
    && tasks.every((task) => expandedTasks.has(task.id));

  function toggleAll() {
    if (allExpanded) {
      setExpandedBranches(new Set());
      setExpandedTasks(new Set());
      return;
    }
    setExpandedBranches(new Set(branches.map((branch) => branch.id)));
    setExpandedTasks(new Set(tasks.map((task) => task.id)));
  }

  return (
    <div className="research-tree-explorer">
      <div className="research-tree-toolbar">
        <p>
          <b>{branches.length} research branch{branches.length === 1 ? '' : 'es'}</b>
          <span>Parent-child lines show succession. “Requires” marks cross-dependencies.</span>
        </p>
        <button onClick={toggleAll} type="button">{allExpanded ? 'Collapse all' : 'Expand all'}</button>
      </div>
      <ul className="research-branch-list">
        {branches.map((branch) => {
          const branchOpen = expandedBranches.has(branch.id);
          const readyCount = branch.tasks.filter((task) => researchTaskSelectable(task, safeMinutes)).length;
          const attemptedCount = branch.tasks.filter((task) => task.status === 'attempted').length;
          const containsRecommendation = branch.tasks.some((task) => task.id === recommendedTaskId);
          const branchPanelId = `research-branch-${safeDomId(branch.id)}`;
          return (
            <li className={`research-branch${containsRecommendation ? ' recommended' : ''}`} key={branch.id}>
              <button
                aria-controls={branchPanelId}
                aria-expanded={branchOpen}
                className="research-branch-toggle"
                onClick={() => {
                  setExpandedBranches((current) => toggleSetValue(current, branch.id));
                  if (!branchOpen) {
                    setExpandedTasks((current) => {
                      const next = new Set(current);
                      branch.tasks.forEach((task) => next.add(task.id));
                      return next;
                    });
                  }
                }}
                type="button"
              >
                <span className={`tree-chevron${branchOpen ? ' open' : ''}`} aria-hidden="true">›</span>
                <span className="research-branch-copy">
                  <span>
                    <b>{branch.label}</b>
                    {containsRecommendation && <em>AUTOMATIC PICK</em>}
                  </span>
                  <small>{branch.roots[0]?.title ?? 'Independent research direction'}</small>
                </span>
                <span className="research-branch-state">
                  <b>{branch.tasks.length}</b> task{branch.tasks.length === 1 ? '' : 's'}
                  <small>{readyCount} ready{attemptedCount > 0 ? ` · ${attemptedCount} complete` : ''}</small>
                </span>
              </button>
              {branchOpen && (
                <div className="research-branch-body" id={branchPanelId}>
                  <ul className="research-task-tree">
                    {branch.roots.map((task) => (
                      <ResearchTreeTaskNode
                        branch={branch}
                        expandedTasks={expandedTasks}
                        key={task.id}
                        onSelectTask={onSelectTask}
                        onToggleTask={(taskId) => setExpandedTasks((current) => toggleSetValue(current, taskId))}
                        path={new Set()}
                        recommendedTaskId={recommendedTaskId}
                        safeMinutes={safeMinutes}
                        selectedTaskId={selectedTaskId}
                        task={task}
                        taskById={taskById}
                      />
                    ))}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ResearchTreeTaskNode({
  task,
  branch,
  taskById,
  expandedTasks,
  selectedTaskId,
  recommendedTaskId,
  safeMinutes,
  path,
  onToggleTask,
  onSelectTask,
}: {
  task: ResearchTask;
  branch: ResearchBranchTree;
  taskById: Map<string, ResearchTask>;
  expandedTasks: Set<string>;
  selectedTaskId: string | null;
  recommendedTaskId: string | null;
  safeMinutes: number;
  path: Set<string>;
  onToggleTask: (taskId: string) => void;
  onSelectTask: (taskId: string) => void;
}) {
  if (path.has(task.id)) return null;
  const nextPath = new Set(path);
  nextPath.add(task.id);
  const children = branch.children.get(task.id) ?? [];
  const expanded = expandedTasks.has(task.id);
  const selected = selectedTaskId === task.id;
  const selectable = researchTaskSelectable(task, safeMinutes);
  const state = researchTreeTaskState(task, safeMinutes, selected);
  const detailId = `research-task-${safeDomId(task.id)}`;
  const parent = task.parentTaskId ? taskById.get(task.parentTaskId) : null;
  const crossDependencies = task.dependencies.filter((dependency) => dependency !== task.parentTaskId);

  return (
    <li className="research-tree-task">
      <button
        aria-controls={detailId}
        aria-expanded={expanded}
        className={`research-tree-task-toggle${selected ? ' selected' : ''}`}
        onClick={() => {
          onToggleTask(task.id);
          if (selectable) onSelectTask(task.id);
        }}
        title={researchTaskUnavailableReason(task, safeMinutes)}
        type="button"
      >
        <span className={`tree-task-marker marker-${state.tone}`} aria-hidden="true" />
        <span className="tree-task-copy">
          <span className="tree-task-kicker">
            <b>{task.budgetBasis === 'adaptive-slice' || task.id.startsWith(adaptiveSlicePrefix) ? 'PREPARATORY SLICE' : formatTaskKind(task.kind)}</b>
            {task.id === recommendedTaskId && <em>AUTOMATIC PICK</em>}
          </span>
          <strong>{task.title}</strong>
          <small>
            {researchTaskShortTimeLabel(task)}
            {children.length > 0 ? ` · ${children.length} direct successor${children.length === 1 ? '' : 's'}` : ''}
            {(task.unlockCount ?? 0) > 0 ? ` · unlocks ${task.unlockCount}` : ''}
          </small>
        </span>
        <span className={`task-state state-${state.tone}`}>{state.label}</span>
        <span className={`tree-chevron task-chevron${expanded ? ' open' : ''}`} aria-hidden="true">›</span>
      </button>
      {expanded && (
        <div className="research-tree-task-detail" id={detailId}>
          <p>{task.rationale}</p>
          {(parent || crossDependencies.length > 0 || (task.parentTaskId && !parent)) && (
            <div className="tree-relations" aria-label="Task dependencies">
              {task.parentTaskId && (
                <span><b>CHILD OF</b>{parent?.title ?? readableTaskId(task.parentTaskId)}</span>
              )}
              {crossDependencies.map((dependency) => {
                const dependencyTask = taskById.get(dependency);
                return (
                  <span key={dependency}>
                    <b>REQUIRES {dependencyTask?.status === 'attempted' ? '✓' : '○'}</b>
                    {dependencyTask?.title ?? readableTaskId(dependency)}
                  </span>
                );
              })}
            </div>
          )}
          <div className="tree-outcomes">
            <span><b>SUCCESS</b>{task.successCriteria}</span>
            <span><b>USEFUL FAILURE</b>{task.usefulFailureCriteria}</span>
          </div>
          <small>{researchTaskBudgetLabel(task)}</small>
        </div>
      )}
      {expanded && children.length > 0 && (
        <ul className="research-task-tree nested">
          {children.map((child) => (
            <ResearchTreeTaskNode
              branch={branch}
              expandedTasks={expandedTasks}
              key={child.id}
              onSelectTask={onSelectTask}
              onToggleTask={onToggleTask}
              path={nextPath}
              recommendedTaskId={recommendedTaskId}
              safeMinutes={safeMinutes}
              selectedTaskId={selectedTaskId}
              task={child}
              taskById={taskById}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function buildResearchBranchTrees(
  tasks: ResearchTask[],
  recommendedTaskId: string | null,
  safeMinutes: number,
): ResearchBranchTree[] {
  const grouped = new Map<string, ResearchTask[]>();
  for (const task of tasks) {
    const branchTasks = grouped.get(task.branchId) ?? [];
    branchTasks.push(task);
    grouped.set(task.branchId, branchTasks);
  }

  return [...grouped.entries()].map(([id, branchTasks]) => {
    const taskIds = new Set(branchTasks.map((task) => task.id));
    const children = new Map<string, ResearchTask[]>();
    const roots: ResearchTask[] = [];
    for (const task of branchTasks) {
      if (task.parentTaskId && task.parentTaskId !== task.id && taskIds.has(task.parentTaskId)) {
        const siblings = children.get(task.parentTaskId) ?? [];
        siblings.push(task);
        children.set(task.parentTaskId, siblings);
      } else roots.push(task);
    }
    const sortTasks = (left: ResearchTask, right: ResearchTask) => (
      Number(right.id === recommendedTaskId) - Number(left.id === recommendedTaskId)
      || right.priority - left.priority
      || left.title.localeCompare(right.title)
    );
    roots.sort(sortTasks);
    children.forEach((value) => value.sort(sortTasks));
    return {
      id,
      label: formatResearchBranchLabel(id),
      tasks: branchTasks,
      roots: roots.length > 0 ? roots : [...branchTasks].sort(sortTasks),
      children,
    };
  }).sort((left, right) => (
    Number(right.tasks.some((task) => task.id === recommendedTaskId))
      - Number(left.tasks.some((task) => task.id === recommendedTaskId))
    || right.tasks.filter((task) => researchTaskSelectable(task, safeMinutes)).length
      - left.tasks.filter((task) => researchTaskSelectable(task, safeMinutes)).length
    || left.label.localeCompare(right.label)
  ));
}

function researchTreeTaskState(task: ResearchTask, safeMinutes: number, selected: boolean) {
  if (!researchTaskDependenciesReady(task)) return { label: `waiting on ${Math.max(1, task.blockedDependencies?.length ?? task.dependencies.length)}`, tone: 'blocked' };
  if (task.status === 'leased') return { label: 'leased', tone: 'leased' };
  if (task.status === 'attempted') return { label: 'complete', tone: 'attempted' };
  if (researchTaskEstimatedMinutes(task) > safeMinutes) return { label: `needs ~${researchTaskEstimatedMinutes(task)} min`, tone: 'time' };
  if (selected) return { label: 'selected', tone: 'selected' };
  return { label: 'ready', tone: 'available' };
}

function formatResearchBranchLabel(branchId: string) {
  const shortId = branchId.split('-').at(-1)?.slice(0, 5).toUpperCase();
  if (branchId.startsWith('explore-')) return `Contributor branch · ${shortId}`;
  if (branchId.startsWith('alternative-')) return `Alternative branch · ${shortId}`;
  return branchId
    .replaceAll(/[._-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function readableTaskId(taskId: string) {
  return taskId.replaceAll(/[._-]+/g, ' ');
}

function safeDomId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function toggleSetValue(current: Set<string>, value: string) {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

type TerminalTone = 'completed' | 'preserved' | 'caution' | 'failed';

function describeTerminalResult(attempt: AttemptRecord): { label: string; tone: TerminalTone; detail: string } {
  const publication = attempt.publication;
  const valueGateReason = publication?.warning ?? attempt.researchValue?.reason;
  const structured = publication?.status === 'submitted'
    && publication.contributionSource === 'structured-proposal';
  const withheld = publication?.status === 'withheld';
  const fallback = publication?.status === 'submitted'
    && publication.contributionSource === 'privacy-safe-fallback';
  const sourceNote = structured
    ? 'Its latest valid structured findings were submitted for automatic validation.'
    : withheld
      ? `The result was kept local and the task returned to the frontier.${valueGateReason ? ` Reason: ${valueGateReason}` : ''}`
    : fallback
      ? 'No valid structured research proposal was available, so only a recovery record was submitted.'
      : publication?.status === 'failed'
        ? 'Automatic contribution submission failed; the private local artifact remains recoverable and can be retried.'
        : publication?.status === 'claimed'
          ? 'The runner is still preparing the contribution for submission.'
          : publication?.status === 'submitted'
            ? 'The contribution was submitted, but this older connector did not report whether it used a structured proposal.'
            : 'No contribution publication state is available.';
  const noStructuredSuffix = fallback
    ? 'RECOVERY ONLY'
    : withheld
      ? 'VALUE GATE'
    : publication?.status === 'failed'
      ? 'SHARE FAILED'
      : publication?.status === 'claimed'
        ? 'FINALIZING'
        : 'NO SHARED RESULT';

  switch (attempt.terminalDisposition) {
    case 'completed':
      return structured
        ? {
            label: 'COMPLETED',
            tone: 'completed',
            detail: `The bounded Codex run completed. ${sourceNote}`,
          }
        : {
            label: `COMPLETED · ${noStructuredSuffix}`,
            tone: 'caution',
            detail: `Codex ended normally, but a reusable structured contribution is not yet confirmed. ${sourceNote}`,
          };
    case 'time-limit':
      return structured
        ? {
            label: 'PARTIAL CONTRIBUTION SAVED',
            tone: 'preserved',
            detail: `The safe time limit was reached; this is a preserved partial result, not a failed run. ${sourceNote}`,
          }
        : {
            label: `TIME LIMIT · ${noStructuredSuffix}`,
            tone: 'caution',
            detail: `The safe time limit was reached without a confirmed reusable structured result. ${sourceNote}`,
          };
    case 'user-stopped':
      return structured
        ? {
            label: 'STOPPED · CONTRIBUTION SAVED',
            tone: 'preserved',
            detail: `You stopped the run after a durable contribution was available. ${sourceNote}`,
          }
        : {
            label: `STOPPED · ${noStructuredSuffix}`,
            tone: 'caution',
            detail: `You stopped the run without a confirmed reusable structured result. ${sourceNote}`,
          };
    case 'provider-failed':
      return {
        label: structured ? 'PROVIDER FAILED · WORK SAVED' : 'PROVIDER FAILED',
        tone: 'failed',
        detail: structured
          ? `Codex failed unexpectedly, but its latest structured contribution was preserved and submitted.`
          : `Codex failed unexpectedly. ${sourceNote}`,
      };
    case 'runner-stopped':
      return {
        label: structured ? 'RUNNER STOPPED · WORK SAVED' : 'RUNNER STOPPED',
        tone: structured ? 'preserved' : 'caution',
        detail: structured
          ? `The local connector stopped, but its latest structured contribution was preserved and submitted.`
          : `The local connector stopped before a reusable structured result was available. ${sourceNote}`,
      };
    case 'provider-interrupted':
    default:
      return {
        label: structured ? 'INTERRUPTED · WORK SAVED' : 'INTERRUPTED',
        tone: structured ? 'preserved' : 'failed',
        detail: structured
          ? `Codex was interrupted, but its latest structured contribution was preserved and submitted.`
          : `Codex was interrupted before a reusable structured result was available. ${sourceNote}`,
      };
  }
}

function publicationLabel(attempt: AttemptRecord) {
  const publication = attempt.publication;
  if (!publication) return 'No contribution state';
  if (publication.status === 'submitted') {
    return publication.contributionSource === 'structured-proposal'
      ? 'Structured contribution submitted'
      : publication.contributionSource === 'privacy-safe-fallback'
        ? 'Recovery record submitted'
        : 'Submitted for automatic validation';
  }
  if (publication.status === 'claimed') return 'Task claimed; contribution pending';
  if (publication.status === 'withheld') return 'Withheld · task returned to frontier';
  if (publication.status === 'failed') return 'Contribution submission failed';
  return publication.status;
}

function explorationObjective(value: string) {
  const proposed = value.replace(/\s+/g, ' ').trim();
  if (proposed.length < 20) return '';
  return `Investigate this contributor-proposed direction as a distinct branch: ${proposed} First state the smallest falsifiable subclaim, compare it with supplied prior context, and run one check that can produce either reusable evidence or a precise obstruction.`;
}

function formatTaskKind(value: ResearchTask['kind']) {
  return value.replaceAll('-', ' ').toUpperCase();
}

function researchTaskDependenciesReady(task: ResearchTask) {
  return task.status !== 'blocked'
    && task.dependenciesSatisfied !== false
    && (task.blockedDependencies?.length ?? 0) === 0;
}

function researchTaskSelectable(task: ResearchTask, safeMinutes: number) {
  const estimatedMinutes = researchTaskEstimatedMinutes(task);
  return task.status === 'available'
    && researchTaskDependenciesReady(task)
    && estimatedMinutes >= minimumUsefulRunMinutes
    && safeMinutes >= minimumUsefulRunMinutes
    && estimatedMinutes <= safeMinutes;
}

function researchTaskUnavailableReason(task: ResearchTask, safeMinutes: number) {
  if (!researchTaskDependenciesReady(task)) {
    const count = Math.max(1, task.blockedDependencies?.length ?? task.dependencies.length);
    return `Waiting on ${count} unfinished prerequisite${count === 1 ? '' : 's'}`;
  }
  if (task.status === 'leased') return 'Claimed by another contributor';
  if (task.status === 'attempted') return 'A durable attempt already exists';
  const estimatedMinutes = researchTaskEstimatedMinutes(task);
  if (estimatedMinutes < minimumUsefulRunMinutes) return `Below the ${minimumUsefulRunMinutes}-minute useful-work floor`;
  if (estimatedMinutes > safeMinutes) return `Needs about ${estimatedMinutes} safe minutes`;
  return undefined;
}

function researchTaskBudgetLabel(task: ResearchTask) {
  const estimatedMinutes = researchTaskEstimatedMinutes(task);
  if (task.timingBasis === 'observed-kind' && (task.timingSampleCount ?? 0) > 0) {
    const samples = task.timingSampleCount ?? 0;
    return `Estimated ${estimatedMinutes} min from ${samples} completed ${formatTaskKind(task.kind).toLowerCase()} run${samples === 1 ? '' : 's'} · up to ${task.suggestedMinutes} min`;
  }
  if (task.budgetBasis === 'adaptive-slice' || task.id.startsWith(adaptiveSlicePrefix)) {
    return `Fixed ${task.suggestedMinutes} min · preparatory slice; parent stays open`;
  }
  if (task.budgetBasis === 'contributor-plan') {
    return `Up to ${task.suggestedMinutes} min · contributor ceiling; no matching completed-run estimate yet`;
  }
  if (task.budgetBasis === 'verification-plan') {
    return `Up to ${task.suggestedMinutes} min · review ceiling; no matching completed-run estimate yet`;
  }
  if (task.budgetBasis === 'available-window') {
    return `Allocated ${task.suggestedMinutes} min · current safe window`;
  }
  return `Up to ${task.suggestedMinutes} min · editorial ceiling; no matching completed-run estimate yet`;
}

function researchTaskEstimatedMinutes(task: ResearchTask) {
  const estimate = Number(task.estimatedMinutes);
  return Number.isFinite(estimate) ? estimate : task.suggestedMinutes;
}

function researchTaskShortTimeLabel(task: ResearchTask) {
  const estimate = researchTaskEstimatedMinutes(task);
  return task.timingBasis === 'observed-kind' ? `~${estimate} min` : `${estimate} min`;
}

function formatClock(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = whole % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function elapsedFor(attempt: AttemptRecord, now: number) {
  if (terminalStatuses.has(attempt.status)) return Math.max(0, attempt.elapsedSeconds ?? 0);
  const started = Date.parse(attempt.startedAt ?? attempt.createdAt ?? '');
  if (Number.isFinite(started)) return Math.max(0, Math.floor((now - started) / 1000));
  return Math.max(0, attempt.elapsedSeconds ?? 0);
}

function quotaMeters(windows: QuotaWindowEstimate[]) {
  const identify = (window: QuotaWindowEstimate) => `${window.id ?? ''} ${window.label}`.toLowerCase();
  const tightest = (pattern: RegExp) => windows
    .filter((window) => pattern.test(identify(window)))
    .reduce<QuotaWindowEstimate | undefined>((selected, candidate) => {
      if (!selected) return candidate;
      const selectedRemaining = Number.isFinite(selected.remainingPercent) ? Number(selected.remainingPercent) : Infinity;
      const candidateRemaining = Number.isFinite(candidate.remainingPercent) ? Number(candidate.remainingPercent) : Infinity;
      return candidateRemaining < selectedRemaining ? candidate : selected;
    }, undefined);
  const fiveHour = tightest(/(?:5|five)[\s-]*(?:h|hour)/);
  const weekly = tightest(/week|7[\s-]*day/);
  return [
    { key: 'five-hour', label: '5 HOUR', shortLabel: '5H', longLabel: '5-hour quota', window: fiveHour },
    { key: 'weekly', label: 'WEEKLY', shortLabel: 'WK', longLabel: 'weekly quota', window: weekly },
  ];
}

function formatHeaderPercentage(value?: number) {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(Number(value) * 10) / 10;
  return `${rounded}% left`;
}

function formatAccessibleHeaderPercentage(value?: number) {
  return Number.isFinite(value) ? formatHeaderPercentage(value) : 'unavailable';
}

function formatReset(value?: string) {
  if (!value) return 'reset time unavailable';
  const milliseconds = Date.parse(value) - Date.now();
  if (!Number.isFinite(milliseconds)) return 'reset time unavailable';
  if (milliseconds <= 0) return 'reset due';
  const totalMinutes = Math.ceil(milliseconds / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `resets in ${days}d ${hours}h`;
  if (hours) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

function formatPercentageLeft(value?: number) {
  if (!Number.isFinite(value)) return 'percentage unavailable';
  const rounded = Math.round(Number(value) * 10) / 10;
  return `${rounded}% left`;
}

function savePendingConnectorLaunch(ticket: ConnectorLaunch) {
  window.sessionStorage.setItem(pendingConnectorKey, JSON.stringify({ ...ticket, createdAt: Date.now() }));
}

function readPendingConnectorLaunch(): ConnectorLaunch | null {
  try {
    const raw = window.sessionStorage.getItem(pendingConnectorKey);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ConnectorLaunch> & { createdAt?: number };
    const valid = /^[A-Za-z0-9_-]{22}$/.test(value.requestId ?? '')
      && /^[A-Za-z0-9_-]{43}$/.test(value.verifier ?? '')
      && typeof value.url === 'string'
      && value.url.startsWith('http://127.0.0.1:4318/connect/v1?')
      && typeof value.createdAt === 'number'
      && Number.isFinite(value.createdAt)
      && Date.now() - value.createdAt < 2 * 60_000;
    if (valid) return { requestId: value.requestId!, verifier: value.verifier!, url: value.url! };
  } catch {
    // Invalid or unavailable session storage is handled as no pending launch.
  }
  clearPendingConnectorLaunch();
  return null;
}

function clearPendingConnectorLaunch() {
  try { window.sessionStorage.removeItem(pendingConnectorKey); } catch { /* unavailable storage */ }
}

function takeConnectorDecision() {
  const url = new URL(window.location.href);
  const decision = url.searchParams.get('connector');
  if (decision !== 'approved' && decision !== 'denied') return null;
  url.searchParams.delete('connector');
  window.history.replaceState(null, '', url);
  return decision;
}

function messageFrom(reason: unknown) {
  return reason instanceof Error ? reason.message : 'The local Codex connection failed.';
}

async function retryTransientLocalRequest<T>(action: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown = new Error('The local connector request did not complete.');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await action();
    } catch (reason) {
      lastError = reason;
      const status = reason instanceof LocalCompanionError ? reason.status : null;
      const transient = status === null || [500, 502, 503, 504].includes(status);
      if (!transient || attempt === attempts - 1) throw reason;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}
