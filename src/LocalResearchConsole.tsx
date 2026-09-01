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
import type { Problem, Route } from './problems';

const durationOptions = [5, 15, 30, 60] as const;
const minimumSafeMinutes = 5;
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
const researchModes: Array<{ id: ResearchMode; label: string; note: string }> = [
  { id: 'recommended', label: 'Recommended', note: 'Best available fit' },
  { id: 'frontier', label: 'Browse frontier', note: 'Choose a branch' },
  { id: 'explore', label: 'Explore new', note: 'Open another path' },
  { id: 'verify', label: 'Verify result', note: 'Challenge prior work' },
];

type BusyAction = 'pair' | 'refresh' | 'start' | 'checkpoint' | 'stop' | 'publish' | 'disconnect' | null;

export function LocalResearchConsole({ problem, route }: { problem: Problem; route: Route }) {
  const connectInFlight = useRef(false);
  const startInFlight = useRef(false);
  const [launchTicket, setLaunchTicket] = useState<ConnectorLaunch | null>(null);
  const [client, setClient] = useState<LocalCodexClient | null>(null);
  const [sessionExpiresAt, setSessionExpiresAt] = useState<string | null>(null);
  const [provider, setProvider] = useState<CodexProvider | null>(null);
  const [coordination, setCoordination] = useState<{ ready: boolean; syncedAt?: string | null; error?: string | null } | null>(null);
  const [riskMode, setRiskMode] = useState<RiskMode>('balanced');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<CodexEffort>('high');
  const [durationCap, setDurationCap] = useState<'safe' | number>('safe');
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
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const isRunning = Boolean(activeAttempt && !terminalStatuses.has(activeAttempt.status));
  const availableModels = useMemo(() => {
    if (provider?.models?.length) return provider.models;
    return provider?.ready ? [fallbackModel] : [];
  }, [provider]);
  const selectedModel = useMemo(
    () => availableModels.find((candidate) => candidate.model === model) ?? null,
    [availableModels, model],
  );
  const effortOptions = selectedModel?.supportedReasoningEfforts?.length
    ? selectedModel.supportedReasoningEfforts
    : fallbackModel.supportedReasoningEfforts;
  const selectedMinutes = useMemo(() => {
    const safe = Math.max(0, Math.floor(estimate?.allowedMinutes ?? 0));
    const requested = durationCap === 'safe' ? safe : Math.min(durationCap, safe);
    const expires = Date.parse(sessionExpiresAt ?? '');
    const sessionMinutes = Number.isFinite(expires)
      ? Math.max(0, Math.floor((expires - now - 2 * 60_000) / 60_000))
      : 0;
    return Math.min(requested, sessionMinutes);
  }, [durationCap, estimate, now, sessionExpiresAt]);
  const selectedTask = useMemo(
    () => frontier?.tasks.find((task) => task.id === selectedTaskId) ?? null,
    [frontier, selectedTaskId],
  );
  const objective = useMemo(
    () => researchMode === 'explore'
      ? explorationObjective(newDirection)
      : selectedTask?.objective ?? '',
    [newDirection, researchMode, selectedTask],
  );
  const selectionReady = researchMode === 'explore'
    ? newDirection.trim().replace(/\s+/g, ' ').length >= 20
    : selectedTask?.status === 'available';
  const activeAttemptId = activeAttempt?.id ?? null;
  const activeAttemptStatus = activeAttempt?.status ?? null;
  const activePublicationStatus = activeAttempt?.publication?.status ?? null;
  const terminalResult = activeAttempt && terminalStatuses.has(activeAttempt.status)
    ? describeTerminalResult(activeAttempt)
    : null;
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
    retryTransientLocalRequest(() => client.estimate(riskMode))
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
  }, [client, provider?.ready, riskMode]);

  useEffect(() => {
    if (!client || !provider?.ready || !coordination?.ready
      || estimate?.status !== 'ready' || selectedMinutes < minimumSafeMinutes || isRunning) {
      if (!isRunning) setFrontier(null);
      setFrontierLoading(false);
      return undefined;
    }
    let cancelled = false;
    setFrontierLoading(true);
    retryTransientLocalRequest(() => client.frontier(problem.uiSlug, route.id, selectedMinutes))
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
    selectedMinutes,
  ]);

  useEffect(() => {
    if (!frontier || isRunning) return;
    const isAvailable = (task: ResearchTask | undefined) => task?.status === 'available';
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
      && (task.kind === 'review') === wantsReview);
    setSelectedTaskId(next?.id ?? null);
  }, [frontier, isRunning, researchMode, selectedTaskId]);

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
        const refreshedEstimate = await retryTransientLocalRequest(() => client.estimate(riskMode));
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
    if (!client || !provider?.ready || !estimate || estimate.status !== 'ready' || !model || startInFlight.current) return;
    if (!selectionReady || objective.trim().length < 20) {
      setError(researchMode === 'explore'
        ? 'Describe a distinct research direction in at least 20 characters.'
        : 'Choose an available task from the local research frontier.');
      return;
    }
    if (selectedMinutes < minimumSafeMinutes) {
      setError('At least 5 safe minutes are required to start a bounded run.');
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
        requestedMinutes: selectedMinutes,
        model,
        effort,
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

  async function checkpointAndStop() {
    if (!client || !activeAttempt) return;
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
  const catalogTasks = frontier?.tasks.filter((task) => task.kind !== 'review') ?? [];
  const verificationTasks = frontier?.tasks.filter((task) => task.kind === 'review') ?? [];
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
            <div className="setup-command">
              <span>ONE-TIME SETUP FROM THE PUBLIC REPOSITORY</span>
              <code>git clone https://github.com/LittleSeattlers/Millennium-UI.git<br />cd Millennium-UI<br />gh auth login<br />pnpm install<br />pnpm connector:install</code>
            </div>
            <small>Install it once on Windows. After setup, it starts in the background and no terminal needs to remain open.</small>
          </details>
        </div>
      ) : (
        <>
          {!isRunning && (
            <div className="research-composer">
              <div className="composer-controls">
                <div className="control-group risk-control">
                  <span>ALLOWANCE POLICY</span>
                  <div className="segmented-control">
                    {(['protect', 'balanced', 'harvest'] as RiskMode[]).map((mode) => (
                      <button
                        className={riskMode === mode ? 'active' : ''}
                        key={mode}
                        onClick={() => setRiskMode(mode)}
                        type="button"
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="control-group">
                  <span>MODEL</span>
                  <select
                    disabled={availableModels.length === 0}
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
                <label className="control-group">
                  <span>REASONING EFFORT</span>
                  <select onChange={(event) => setEffort(event.target.value as CodexEffort)} value={effort}>
                    {effortOptions.map((option) => (
                      <option key={option} value={option}>{effortLabels[option]}</option>
                    ))}
                  </select>
                </label>
                <label className="control-group">
                  <span>RUN CAP</span>
                  <select
                    onChange={(event) => setDurationCap(event.target.value === 'safe' ? 'safe' : Number(event.target.value))}
                    value={durationCap}
                  >
                    <option value="safe">Safe maximum</option>
                    {durationOptions.map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}
                  </select>
                </label>
              </div>

              <div className="frontier-panel">
                <div className="frontier-heading">
                  <div>
                    <span>SHARED RESEARCH FRONTIER</span>
                    <b>Choose an unclaimed task built from curated and trusted attempts.</b>
                  </div>
                  {frontier && (
                    <div className="frontier-counts" aria-label="Local task states">
                      <span><b>{frontier.counts.available}</b> available</span>
                      <span><b>{frontier.counts.attempted}</b> attempted</span>
                      {frontier.counts.leased > 0 && <span><b>{frontier.counts.leased}</b> leased</span>}
                    </div>
                  )}
                </div>
                <div className="research-mode-tabs" aria-label="Research task mode">
                  {researchModes.map((mode) => (
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
                    selectedTask ? (
                      <ResearchTaskCard selected task={selectedTask} />
                    ) : (
                      <p className="frontier-empty">
                        No curated task is available for this route. Open <b>Explore new</b> to add a distinct direction.
                      </p>
                    )
                  )}

                  {!frontierLoading && researchMode === 'frontier' && (
                    catalogTasks.length > 0 ? (
                      <div className="frontier-task-list">
                        {catalogTasks.map((task) => (
                          <button
                            className={`frontier-task-choice${selectedTaskId === task.id ? ' selected' : ''}`}
                            disabled={task.status !== 'available'}
                            key={task.id}
                            onClick={() => setSelectedTaskId(task.id)}
                            type="button"
                          >
                            <ResearchTaskCard selected={selectedTaskId === task.id} task={task} />
                          </button>
                        ))}
                      </div>
                    ) : <p className="frontier-empty">No curated tasks are defined for this route yet.</p>
                  )}

                  {!frontierLoading && researchMode === 'verify' && (
                    verificationTasks.length > 0 ? (
                      <div className="frontier-task-list">
                        {verificationTasks.map((task) => (
                          <button
                            className={`frontier-task-choice${selectedTaskId === task.id ? ' selected' : ''}`}
                            disabled={task.status !== 'available'}
                            key={task.id}
                            onClick={() => setSelectedTaskId(task.id)}
                            type="button"
                          >
                            <ResearchTaskCard selected={selectedTaskId === task.id} task={task} />
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
                    <label className="new-direction-field" htmlFor="new-research-direction">
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

              <div className="estimate-row">
                <div className={`allowance-card${estimate?.status === 'blocked' ? ' blocked' : ''}`}>
                  <span>SAFE ALLOWANCE</span>
                  <strong>{estimate ? estimate.allowedMinutes : '—'}<small> min</small></strong>
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
                    disabled={busy !== null || !provider?.ready || !coordination?.ready || !model || estimate?.status !== 'ready' || selectedMinutes < minimumSafeMinutes || !selectionReady || objective.trim().length < 20}
                    onClick={() => void startWork()}
                    type="button"
                  >
                    {busy === 'start'
                      ? 'Claiming task & starting…'
                      : selectedMinutes < minimumSafeMinutes
                        ? 'Need 5 safe minutes'
                        : `Start work · ${selectedMinutes} min`}
                  </button>
                  <small>The selected duration includes a 2-minute reserved wrap-up. This click creates an expiring draft claim PR, runs Codex, then submits one canonical contribution with best-effort credential screening automatically.</small>
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

function ResearchTaskCard({ task, selected }: { task: ResearchTask; selected: boolean }) {
  return (
    <span className="research-task-card">
      <span className="task-card-meta">
        <b>{formatTaskKind(task.kind)}</b>
        <i>{task.branchId.replaceAll('-', ' ')}</i>
        <em className={`task-state state-${task.status}`}>
          {selected && task.status === 'available' ? 'selected' : task.status}
        </em>
      </span>
      <strong>{task.title}</strong>
      <p>{task.rationale}</p>
      <small>Suggested {task.suggestedMinutes} min · Useful failure is preserved</small>
    </span>
  );
}

type TerminalTone = 'completed' | 'preserved' | 'caution' | 'failed';

function describeTerminalResult(attempt: AttemptRecord): { label: string; tone: TerminalTone; detail: string } {
  const publication = attempt.publication;
  const structured = publication?.status === 'submitted'
    && publication.contributionSource === 'structured-proposal';
  const fallback = publication?.status === 'submitted'
    && publication.contributionSource === 'privacy-safe-fallback';
  const sourceNote = structured
    ? 'Its latest valid structured findings were submitted for automatic validation.'
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
