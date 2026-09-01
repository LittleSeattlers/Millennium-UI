import { labelForWindow, makeSnapshot } from '../quota.mjs';
import { sanitizePublicText, subscriptionEnvironment } from '../security.mjs';
import { JsonRpcChild } from './json-rpc-child.mjs';
import { resolveCodexExecutable, runCapture } from './process.mjs';

const CODEX_OVERRIDE = process.env.MILLENNIUM_CODEX_BIN;
// thread/start uses the SandboxMode enum (kebab-case). The turn/start
// sandboxPolicy below is a different tagged object whose type remains camelCase.
export const CODEX_THREAD_SANDBOX_MODE = 'workspace-write';

export function codexWorkspaceWritePolicy(codePath, networkAccess) {
  return {
    type: 'workspaceWrite',
    writableRoots: [codePath],
    networkAccess: Boolean(networkAccess),
  };
}
export async function probeCodex({ onSnapshot } = {}) {
  const resolved = await resolveCodexExecutable(CODEX_OVERRIDE);
  if (!resolved.path) {
    return providerUnavailable('codex', resolved.reason, resolved.discoveredPath);
  }

  let version = 'unknown';
  try {
    const versionResult = await runCapture(resolved.path, ['--version'], {
      env: subscriptionEnvironment('codex'),
      timeoutMs: 5_000,
    });
    if (versionResult.code === 0) version = sanitizePublicText(versionResult.stdout.trim()).slice(0, 120);
  } catch {
    // App-server below is the authoritative readiness check.
  }

  const rpc = new JsonRpcChild({
    executable: resolved.path,
    args: ['app-server'],
    env: subscriptionEnvironment('codex'),
  });
  try {
    await rpc.start();
    const accountResult = await rpc.request('account/read', { refreshToken: false });
    const account = normalizeAccount(accountResult?.account);
    if (account.type !== 'chatgpt') {
      return {
        id: 'codex',
        installed: true,
        executable: resolved.path,
        version,
        ready: false,
        authKind: account.type ?? 'signed-out',
        planType: account.planType,
        reason: account.type === 'apiKey'
          ? 'Codex is signed in with an API key. Sign in with ChatGPT for a subscription-only run.'
          : 'Codex subscription authentication could not be verified.',
        snapshot: null,
      };
    }
    const limits = await rpc.request('account/rateLimits/read', {});
    const snapshot = snapshotFromRateLimits(limits, account);
    await onSnapshot?.(snapshot);
    const billingRisk = codexPaidFallbackRisk(limits);
    return {
      id: 'codex',
      installed: true,
      executable: resolved.path,
      version,
      ready: snapshot.windows.length > 0 && !billingRisk,
      authKind: 'subscription',
      planType: account.planType,
      reason: billingRisk ?? (snapshot.windows.length > 0 ? null : 'Codex returned no active ChatGPT rate-limit windows.'),
      snapshot,
    };
  } catch (error) {
    return {
      id: 'codex',
      installed: true,
      executable: resolved.path,
      version,
      ready: false,
      authKind: 'unknown',
      planType: null,
      reason: `Codex could not be started: ${safeError(error)}`,
      snapshot: null,
    };
  } finally {
    await rpc.close();
  }
}

export async function startCodexRun({
  attempt,
  prompt,
  effort,
  networkAccess,
  onEvent,
  onRaw,
  onSnapshot,
  createRpc = (options) => new JsonRpcChild(options),
  resolveExecutable = () => resolveCodexExecutable(CODEX_OVERRIDE),
}) {
  const resolved = await resolveExecutable();
  if (!resolved.path) throw new Error(resolved.reason);

  let threadId = null;
  let turnId = null;
  let finished = false;
  let finishResolve;
  let quotaRefreshPending = false;
  let finalizationRequest = null;
  let lastUsage = null;
  const completion = new Promise((resolve) => { finishResolve = resolve; });

  const rpc = createRpc({
    executable: resolved.path,
    args: ['app-server'],
    cwd: attempt.codePath,
    env: subscriptionEnvironment('codex'),
    onRaw,
    onStderr: (text) => onRaw?.(JSON.stringify({ stream: 'stderr', text })),
    onExit: ({ error, code, signal }) => {
      if (finished) return;
      finished = true;
      finishResolve({
        status: 'failed',
        error: error ? safeError(error) : `Codex exited before completing the turn (${code ?? signal ?? 'unknown'}).`,
        usage: lastUsage,
      });
    },
    onServerRequest: async (message) => {
      await onEvent({
        kind: 'GUARD',
        level: 'warning',
        message: 'Codex requested an interactive permission; Millennium declined it.',
        detail: message.method,
      });
      if (message.method.includes('requestApproval')) return { decision: 'decline' };
      throw new Error('Millennium does not auto-answer provider prompts.');
    },
    onNotification: (message) => {
      void handleNotification(message);
    },
  });

  const refreshQuota = async () => {
    if (quotaRefreshPending || finished) return;
    quotaRefreshPending = true;
    try {
      const limits = await rpc.request('account/rateLimits/read', {});
      const snapshot = snapshotFromRateLimits(limits, { type: 'chatgpt', planType: null });
      const billingRisk = codexPaidFallbackRisk(limits);
      if (billingRisk) {
        snapshot.windows = snapshot.windows.map((window) => ({
          ...window,
          status: 'rejected',
          reachedType: 'paid-fallback-risk',
        }));
        await onEvent({
          kind: 'GUARD',
          level: 'error',
          message: 'Codex billing safety changed; the attempt is stopping.',
          detail: billingRisk,
        });
      }
      await onSnapshot(snapshot);
    } catch (error) {
      await onEvent({ kind: 'GUARD', level: 'warning', message: 'Could not refresh Codex quota.', detail: safeError(error) });
    } finally {
      quotaRefreshPending = false;
    }
  };

  const handleNotification = async (message) => {
    if (message.method === 'account/rateLimits/updated') {
      await refreshQuota();
      return;
    }
    const event = normalizeCodexNotification(message, attempt.codePath);
    if (event) await onEvent(event);
    if (message.method === 'thread/tokenUsage/updated') {
      lastUsage = numericShape(message.params);
    }
    if (message.method === 'turn/started') turnId = message.params?.turn?.id ?? turnId;
    if (message.method === 'turn/completed') {
      finished = true;
      const turn = message.params?.turn ?? {};
      finishResolve({
        status: turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'interrupted' : 'failed',
        error: turn.error?.message ?? null,
        usage: lastUsage,
      });
      setTimeout(() => void rpc.close(), 300).unref?.();
    }
  };

  try {
    await rpc.start();
    const accountResult = await rpc.request('account/read', { refreshToken: false });
    const account = normalizeAccount(accountResult?.account);
    if (account.type !== 'chatgpt') {
      throw new Error('Codex is not authenticated with a ChatGPT subscription.');
    }
    const limits = await rpc.request('account/rateLimits/read', {});
    const billingRisk = codexPaidFallbackRisk(limits);
    if (billingRisk) throw new Error(billingRisk);
    await onSnapshot(snapshotFromRateLimits(limits, account));

    const threadResult = await rpc.request('thread/start', {
      cwd: attempt.codePath,
      approvalPolicy: 'never',
      sandbox: CODEX_THREAD_SANDBOX_MODE,
      serviceName: 'millennium',
    }, 20_000);
    threadId = threadResult?.thread?.id;
    if (!threadId) throw new Error('Codex did not return a thread id.');

    const turnResult = await rpc.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt }],
      cwd: attempt.codePath,
      approvalPolicy: 'never',
      sandboxPolicy: codexWorkspaceWritePolicy(attempt.codePath, networkAccess),
      effort,
      summary: 'concise',
    }, 30_000);
    turnId = turnResult?.turn?.id ?? turnId;

    return {
      provider: 'codex',
      threadId,
      turnId,
      completion,
      refreshQuota,
      requestFinalization(finalizationPrompt) {
        if (finalizationRequest) return finalizationRequest;
        if (finished) return Promise.resolve({ steered: false, reason: 'turn-finished' });
        if (!threadId || !turnId) {
          return Promise.reject(new Error('Codex did not expose an active turn for finalization.'));
        }
        finalizationRequest = rpc.request('turn/steer', {
          threadId,
          input: [{ type: 'text', text: finalizationPrompt }],
          expectedTurnId: turnId,
        }, 10_000).then(() => ({ steered: true }));
        return finalizationRequest;
      },
      async stop() {
        if (finished) return;
        if (threadId && turnId) {
          try {
            await rpc.request('turn/interrupt', { threadId, turnId }, 4_000);
            const outcome = await Promise.race([
              completion,
              new Promise((resolve) => setTimeout(() => resolve(null), 3_000)),
            ]);
            if (outcome) return;
          } catch {
            // Force-close below.
          }
        }
        finished = true;
        finishResolve({ status: 'interrupted', error: null, usage: null });
        await rpc.close(500);
      },
    };
  } catch (error) {
    if (threadId && turnId) {
      try { await rpc.request('turn/interrupt', { threadId, turnId }, 2_000); } catch { /* force-close below */ }
    }
    await rpc.close(500);
    throw error;
  }
}

export function snapshotFromRateLimits(result, account) {
  const windows = [];
  const buckets = result?.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length > 0
    ? result.rateLimitsByLimitId
    : result?.rateLimits
      ? { [result.rateLimits.limitId ?? 'codex']: result.rateLimits }
      : {};
  for (const [limitId, bucket] of Object.entries(buckets)) {
    for (const role of ['primary', 'secondary']) {
      const value = bucket?.[role];
      if (!value || !Number.isFinite(Number(value.usedPercent)) || !Number.isFinite(Number(value.resetsAt))) continue;
      const duration = Number(value.windowDurationMins);
      windows.push({
        id: `${limitId}:${role}`,
        label: bucket.limitName
          ? `${bucket.limitName} - ${labelForWindow(duration)}`
          : labelForWindow(duration),
        usedPercent: Number(value.usedPercent),
        windowMinutes: duration,
        resetsAt: Number(value.resetsAt),
        reachedType: bucket.rateLimitReachedType ?? null,
        status: bucket.rateLimitReachedType ? 'rejected' : 'allowed',
      });
    }
  }
  const metadata = {
    provider: 'codex',
    source: 'codex-app-server',
    account: { type: 'subscription', planType: account?.planType ?? null },
  };
  return windows.length > 0
    ? makeSnapshot({ ...metadata, windows })
    : { ...metadata, capturedAt: new Date().toISOString(), windows: [] };
}

export function codexPaidFallbackRisk(result) {
  const buckets = result?.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length > 0
    ? Object.values(result.rateLimitsByLimitId)
    : result?.rateLimits
      ? [result.rateLimits]
      : [];
  for (const bucket of buckets) {
    if (bucket?.individualLimit != null) {
      return 'Codex reported a workspace spend-control limit. Millennium refuses credit-backed or ambiguous billing states.';
    }
    if (bucket?.spendControlReached === true) {
      return 'Codex reported that workspace spend control was reached.';
    }
    if (bucket?.credits != null) {
      const credits = bucket.credits;
      const balance = Number.parseFloat(String(credits.balance ?? 'NaN'));
      const knownEmpty = credits.hasCredits === false
        && credits.unlimited === false
        && Number.isFinite(balance)
        && balance <= 0;
      if (!knownEmpty) {
        return 'Codex reported available or ambiguous workspace credits. Millennium will not risk credit fallback.';
      }
    }
  }
  return null;
}

export function normalizeCodexNotification(message, codePath = '') {
  const method = message?.method;
  const params = message?.params ?? {};
  if (!method) return null;
  if (method.startsWith('item/reasoning/')) return null;
  if (method === 'thread/started') return { kind: 'CONTEXT', message: 'Codex research thread started.', detail: null };
  if (method === 'turn/started') return { kind: 'TASK', message: 'Codex began the bounded attempt.', detail: null };
  if (method === 'turn/plan/updated') {
    const steps = (params.plan ?? []).map((item) => `${item.status}: ${item.step}`).join(' | ');
    return { kind: 'PLAN', message: params.explanation ?? 'Codex updated its plan.', detail: clean(steps, codePath) };
  }
  if (method === 'thread/tokenUsage/updated') {
    return { kind: 'USAGE', message: 'Codex reported token usage.', detail: JSON.stringify(numericShape(params)) };
  }
  if (method === 'warning' || method === 'configWarning' || method === 'protocol/error') {
    return { kind: 'WARNING', level: 'warning', message: clean(params.message ?? params.summary ?? 'Provider warning.', codePath), detail: clean(params.details ?? '', codePath) };
  }
  if (method === 'error') {
    const info = params.error?.codexErrorInfo;
    return {
      kind: info === 'UsageLimitExceeded' ? 'QUOTA' : 'ERROR',
      level: 'error',
      message: clean(params.error?.message ?? 'Codex turn failed.', codePath),
      detail: typeof info === 'string' ? info : null,
    };
  }
  if (method === 'turn/completed') {
    const status = params.turn?.status ?? 'unknown';
    return { kind: 'FINAL', level: status === 'completed' ? 'info' : 'warning', message: `Codex turn ${status}.`, detail: clean(params.turn?.error?.message ?? '', codePath) };
  }
  if (method !== 'item/started' && method !== 'item/completed') return null;

  const item = params.item ?? {};
  const complete = method === 'item/completed';
  switch (item.type) {
    case 'agentMessage':
      return complete && item.text ? { kind: item.phase === 'final_answer' ? 'RESULT' : 'MESSAGE', message: clean(item.text, codePath), detail: item.phase ?? null } : null;
    case 'plan':
      return complete ? { kind: 'PLAN', message: clean(item.text ?? 'Plan updated.', codePath), detail: null } : null;
    case 'commandExecution':
      return {
        kind: 'COMPUTE',
        message: complete ? `Command ${item.status ?? 'completed'}.` : 'Command started.',
        detail: clean(`${item.command ?? ''}${complete && item.exitCode !== undefined ? ` (exit ${item.exitCode})` : ''}`, codePath),
      };
    case 'fileChange': {
      const changes = (item.changes ?? []).map((change) => `${change.kind}: ${change.path}`).join(', ');
      return { kind: 'ARTIFACT', message: complete ? 'File changes completed.' : 'Preparing file changes.', detail: clean(changes, codePath) };
    }
    case 'webSearch':
      return { kind: 'SOURCE', message: complete ? 'Web search completed.' : 'Searching the web.', detail: clean(item.query ?? '', codePath) };
    case 'mcpToolCall':
      return { kind: 'TOOL', message: `${item.server ?? 'MCP'} / ${item.tool ?? 'tool'} ${item.status ?? (complete ? 'completed' : 'started')}.`, detail: null };
    case 'contextCompaction':
      return { kind: 'CONTEXT', message: 'Codex compacted its working context.', detail: null };
    case 'reasoning':
      return null;
    default:
      return complete ? { kind: 'ACTIVITY', message: `${item.type ?? 'Provider item'} completed.`, detail: null } : null;
  }
}

function normalizeAccount(account) {
  return { type: account?.type ?? null, planType: account?.planType ?? null };
}

function providerUnavailable(id, reason, discoveredPath = null) {
  return { id, installed: Boolean(discoveredPath), executable: discoveredPath, version: null, ready: false, authKind: 'unknown', planType: null, reason, snapshot: null };
}

function safeError(error) {
  return sanitizePublicText(error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function clean(value, codePath) {
  return sanitizePublicText(value ?? '', codePath ? [[codePath, '$ATTEMPT/code']] : []);
}

function numericShape(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => numericShape(item, depth + 1)).filter((item) => item !== undefined);
  if (typeof value !== 'object') return undefined;
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    const normalized = numericShape(nested, depth + 1);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}
