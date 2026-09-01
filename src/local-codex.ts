export type RiskMode = 'protect' | 'balanced' | 'harvest';
export type CodexEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type AttemptStatus = 'planned' | 'queued' | 'starting' | 'running' | 'stopping' | 'completed' | 'interrupted' | 'aborted' | 'failed';
export type TerminalDisposition = 'completed' | 'time-limit' | 'user-stopped' | 'provider-failed' | 'provider-interrupted' | 'runner-stopped';
export type ResearchMode = 'recommended' | 'frontier' | 'explore' | 'verify';
export type ResearchTaskStatus = 'available' | 'leased' | 'attempted';

export type ResearchTask = {
  id: string;
  problemId: string;
  direction: string;
  branchId: string;
  kind: 'proof' | 'counterexample-search' | 'computation' | 'formalization' | 'review' | 'synthesis' | 'exploration';
  title: string;
  objective: string;
  rationale: string;
  successCriteria: string;
  usefulFailureCriteria: string;
  verificationMethod: string;
  suggestedMinutes: number;
  priority: number;
  dependencies: string[];
  status: ResearchTaskStatus;
  attemptCount: number;
};

export type ResearchFrontier = {
  schemaVersion: 1;
  problemId: string;
  direction: string;
  safeMinutes: number;
  recommendedTaskId: string | null;
  tasks: ResearchTask[];
  branches: Array<{
    id: string;
    available: number;
    leased: number;
    attempted: number;
  }>;
  counts: {
    available: number;
    leased: number;
    attempted: number;
    verification: number;
  };
};

export type AttemptResearchTask = {
  taskId: string;
  branchId: string;
  mode: ResearchMode;
  kind: string;
  title: string;
};

export type RunnerHealth = {
  ok: boolean;
  version?: string;
  activeAttemptId?: string | null;
  busy?: boolean;
  coordination?: {
    ready: boolean;
    syncedAt?: string | null;
    error?: string | null;
  };
};

export type ConnectorLaunch = {
  requestId: string;
  verifier: string;
  url: string;
};

export type CodexProvider = {
  id: 'codex';
  installed: boolean;
  ready: boolean;
  version?: string | null;
  authKind?: string | null;
  reason?: string | null;
};

export type QuotaWindowEstimate = {
  id?: string;
  label: string;
  remainingPercent?: number;
  resetsAt?: string;
  allowedMinutes?: number;
};

export type QuotaEstimate = {
  status: 'ready' | 'blocked';
  allowedMinutes: number;
  checkpointMinutes?: number;
  calibration?: boolean;
  confidence?: string | null;
  bottleneck?: string | null;
  reason: string;
  windows?: QuotaWindowEstimate[];
};

export type AttemptRecord = {
  id: string;
  provider: 'codex';
  problem?: string;
  problemId?: string;
  problemName?: string;
  direction?: string;
  route?: string;
  routeLabel?: string;
  objective?: string;
  researchTask?: AttemptResearchTask | null;
  status: AttemptStatus;
  terminalDisposition?: TerminalDisposition | null;
  riskMode?: RiskMode;
  effort?: string;
  allowedMinutes?: number;
  elapsedSeconds?: number;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  publication?: {
    status: 'claimed' | 'submitted' | 'failed' | string;
    prUrl?: string | null;
    prNumber?: number | null;
    warning?: string | null;
    error?: string | null;
    contributionSource?: 'structured-proposal' | 'privacy-safe-fallback' | null;
  } | null;
};

export type RunnerEvent = {
  seq: number;
  attemptId?: string;
  at?: string;
  timestamp?: string;
  kind: string;
  level?: 'info' | 'warning' | 'error';
  message: string;
  detail?: string | null;
};

export type HostedRunnerState = {
  health: RunnerHealth;
  provider: CodexProvider | null;
  activeAttempt: AttemptRecord | null;
};

export type StartAttemptRequest = {
  provider: 'codex';
  problemId: string;
  direction: string;
  riskMode: RiskMode;
  requestedMinutes: number;
  effort: CodexEffort;
  objective: string;
  taskMode: ResearchMode;
  taskId?: string;
  newDirection?: string;
};

const RUNNER_ORIGIN = 'http://127.0.0.1:4318';
const PUBLIC_API = '/api/v1/public';

export class LocalCodexClient {
  private constructor(private readonly token: string) {}

  static async pair(
    credential: string | Pick<ConnectorLaunch, 'requestId' | 'verifier'>,
    signal?: AbortSignal,
  ) {
    const payload = await publicRequest<{
      sessionToken: string;
      expiresAt: string;
      health: RunnerHealth;
    }>(`${PUBLIC_API}/pair`, {
      method: 'POST',
      body: JSON.stringify(typeof credential === 'string'
        ? { code: credential }
        : { requestId: credential.requestId, verifier: credential.verifier }),
      signal,
    });
    if (!/^[A-Za-z0-9_-]{32,}$/.test(payload.sessionToken)) {
      throw new Error('The local companion returned an invalid session. Restart it and try again.');
    }
    return {
      client: new LocalCodexClient(payload.sessionToken),
      expiresAt: payload.expiresAt,
      health: payload.health,
    };
  }

  static async pairLaunchedConnector(ticket: ConnectorLaunch, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      try {
        return await LocalCodexClient.pair(ticket, AbortSignal.timeout(Math.min(1200, remaining)));
      } catch (error) {
        lastError = error;
        if (error instanceof LocalCompanionError
          && ![401, 404, 500, 502, 503, 504].includes(error.status)) throw error;
        const delayMs = Math.min(450, Math.max(0, deadline - Date.now()));
        if (delayMs > 0) await retryDelay(delayMs);
      }
    }
    if (lastError instanceof LocalCompanionError && lastError.status >= 500) {
      throw new Error('The local connector stayed temporarily unavailable while pairing. Click Connect and approve it once more.');
    }
    throw new Error('The local connector did not complete pairing. Run the one-time installer again, then retry.');
  }

  state() {
    return this.request<HostedRunnerState>('/state');
  }

  revoke() {
    return this.request<{ revoked: true }>('/session/revoke', {
      method: 'POST',
      body: '{}',
    });
  }

  async refresh() {
    const payload = await this.request<{ provider: CodexProvider | null }>('/providers/refresh', {
      method: 'POST',
      body: '{}',
    });
    return payload.provider;
  }

  async estimate(riskMode: RiskMode) {
    const payload = await this.request<{ estimate: QuotaEstimate }>('/quota/estimate', {
      method: 'POST',
      body: JSON.stringify({ riskMode }),
    });
    return payload.estimate;
  }

  frontier(problemId: string, direction: string, safeMinutes: number) {
    const query = new URLSearchParams({
      problemId,
      direction,
      minutes: String(Math.max(1, Math.floor(safeMinutes))),
    });
    return this.request<ResearchFrontier>(`/frontier?${query.toString()}`);
  }

  async start(request: StartAttemptRequest) {
    const payload = await this.request<{ attempt: AttemptRecord }>('/attempts', {
      method: 'POST',
      body: JSON.stringify({ ...request, startRequestId: randomBase64Url(16) }),
    });
    return payload.attempt;
  }

  async getAttempt(id: string) {
    const payload = await this.request<{ attempt: AttemptRecord }>(`/attempts/${encodeURIComponent(id)}`);
    return payload.attempt;
  }

  async checkpoint(id: string, stop = false) {
    const payload = await this.request<{ attempt: AttemptRecord }>(`/attempts/${encodeURIComponent(id)}/checkpoint`, {
      method: 'POST',
      body: JSON.stringify({ stop }),
    });
    return payload.attempt;
  }

  async stop(id: string) {
    const payload = await this.request<{ attempt: AttemptRecord }>(`/attempts/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
      body: '{}',
    });
    return payload.attempt;
  }

  async retryPublication(id: string) {
    const payload = await this.request<{ attempt: AttemptRecord }>(`/attempts/${encodeURIComponent(id)}/publish`, {
      method: 'POST',
      body: '{}',
    });
    return payload.attempt;
  }

  async streamEvents(
    attemptId: string,
    after: number,
    onEvent: (event: RunnerEvent) => void,
    signal: AbortSignal,
  ) {
    let cursor = after;
    let failures = 0;
    while (!signal.aborted) {
      try {
        const response = await loopbackFetch(
          `${RUNNER_ORIGIN}${PUBLIC_API}/attempts/${encodeURIComponent(attemptId)}/events?after=${cursor}`,
          {
            headers: { Accept: 'text/event-stream', Authorization: `Bearer ${this.token}` },
            cache: 'no-store',
            signal,
          },
        );
        if (!response.ok) throw await responseError(response);
        if (!response.body) throw new Error('The local companion returned no event stream.');
        failures = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let eventData: string[] = [];
        let eventId: number | null = null;

        const dispatch = () => {
          if (eventData.length === 0) return;
          const data = eventData.join('\n');
          eventData = [];
          try {
            const value = JSON.parse(data) as Record<string, unknown>;
            const event = normalizeEvent(value, eventId ?? cursor + 1, attemptId);
            cursor = Math.max(cursor, event.seq);
            onEvent(event);
          } catch {
            // Heartbeats and malformed control frames are ignored.
          }
          eventId = null;
        };

        while (!signal.aborted) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          let newline = buffer.indexOf('\n');
          while (newline >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, '');
            buffer = buffer.slice(newline + 1);
            if (line === '') dispatch();
            else if (line.startsWith('data:')) eventData.push(line.slice(5).trimStart());
            else if (line.startsWith('id:')) eventId = Number.parseInt(line.slice(3).trim(), 10);
            newline = buffer.indexOf('\n');
          }
          if (done) {
            dispatch();
            break;
          }
        }
        if (!signal.aborted) await delay(750, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof LocalCompanionError && error.status === 401) throw error;
        failures += 1;
        await delay(Math.min(10_000, 500 * (2 ** Math.min(failures - 1, 5))), signal);
      }
    }
  }

  private request<T>(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.token}`);
    return publicRequest<T>(`${PUBLIC_API}${path}`, { ...init, headers });
  }
}

async function publicRequest<T>(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await loopbackFetch(`${RUNNER_ORIGIN}${path}`, {
      ...init,
      headers,
      cache: 'no-store',
    });
  } catch {
    throw new Error('The local companion is unreachable. Click Connect to launch the installed Millennium Connector.');
  }
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<T>;
}

export async function prepareConnectorLaunch(): Promise<ConnectorLaunch> {
  const verifier = randomBase64Url(32);
  const requestId = randomBase64Url(16);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = bytesToBase64Url(new Uint8Array(digest));
  const url = new URL(`${RUNNER_ORIGIN}/connect/v1`);
  url.searchParams.set('request_id', requestId);
  url.searchParams.set('challenge', challenge);
  url.searchParams.set('return_to', new URL(window.location.pathname, window.location.origin).toString());
  return { requestId, verifier, url: url.toString() };
}

function randomBase64Url(bytes: number) {
  const value = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(value);
  return bytesToBase64Url(value);
}

function bytesToBase64Url(value: Uint8Array) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function retryDelay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

function loopbackFetch(input: string, init: RequestInit) {
  const localRequest = { ...init, targetAddressSpace: 'loopback' } as RequestInit;
  return fetch(input, localRequest);
}

function normalizeEvent(value: Record<string, unknown>, fallbackSeq: number, attemptId: string): RunnerEvent {
  return {
    seq: finiteNumber(value.seq ?? value.sequence) ?? fallbackSeq,
    attemptId: String(value.attemptId ?? attemptId),
    at: stringOrUndefined(value.at ?? value.timestamp ?? value.createdAt),
    timestamp: stringOrUndefined(value.timestamp ?? value.at ?? value.createdAt),
    kind: String(value.kind ?? value.type ?? 'ACTIVITY').toUpperCase(),
    level: value.level === 'warning' || value.level === 'error' ? value.level : 'info',
    message: String(value.message ?? value.text ?? 'Runner activity'),
    detail: value.detail == null ? null : String(value.detail),
  };
}

async function responseError(response: Response) {
  let message = `Local companion request failed (${response.status}).`;
  try {
    const body = await response.json() as Record<string, unknown>;
    if (typeof body.message === 'string') message = body.message;
    else if (body.error && typeof body.error === 'object') {
      const error = body.error as Record<string, unknown>;
      if (typeof error.message === 'string') message = error.message;
    }
  } catch {
    // Keep the status-based message.
  }
  return new LocalCompanionError(message, response.status);
}

export class LocalCompanionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'LocalCompanionError';
  }
}

function finiteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringOrUndefined(value: unknown) {
  return value == null ? undefined : String(value);
}

function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
