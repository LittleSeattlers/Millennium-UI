import { RISK_MODES, SNAPSHOT_MAX_AGE_MS } from './constants.mjs';

const RESET_MARGIN_MINUTES = 2;
const ATTEMPT_BOUNDARY_TOLERANCE_MS = 3 * 60_000;
const MIN_ATTEMPT_SAMPLE_MINUTES = 5;
const MAX_ATTEMPT_SAMPLE_MINUTES = 180;
const PROFILE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const PROFILE_MAX_RUNS = 12;
const PROFILE_PERCENTILE = 0.8;
const CALIBRATION_RUN_MINUTES = 15;
const CALIBRATION_MIN_SAFE_PERCENT = 15;

export function normalizeWindow(window, source = 'manual-provider-ui', defaultCapturedAt = new Date().toISOString()) {
  if (!finite(window.usedPercent) && !finite(window.remainingPercent)) {
    throw new Error('Quota usage percentage is required.');
  }
  const usedPercent = finite(window.usedPercent)
    ? clamp(window.usedPercent, 0, 100)
    : clamp(100 - Number(window.remainingPercent), 0, 100);
  const remainingPercent = clamp(100 - usedPercent, 0, 100);
  const reset = typeof window.resetsAt === 'number'
    ? new Date(window.resetsAt * 1000)
    : new Date(window.resetsAt);
  if (!Number.isFinite(reset.getTime())) throw new Error('Quota reset time is invalid.');
  const windowMinutes = Number(window.windowMinutes);
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0 || windowMinutes > 60 * 24 * 365) {
    throw new Error('Quota window duration is invalid.');
  }
  return {
    id: String(window.id ?? `window-${windowMinutes}`),
    label: String(window.label ?? labelForWindow(windowMinutes)),
    usedPercent,
    remainingPercent,
    windowMinutes,
    resetsAt: reset.toISOString(),
    reachedType: window.reachedType ?? null,
    status: window.status ?? 'allowed',
    source,
    capturedAt: new Date(window.capturedAt ?? defaultCapturedAt).toISOString(),
  };
}
export function makeSnapshot({ provider, source, windows, account = null, capturedAt = new Date().toISOString() }) {
  if (!Array.isArray(windows) || windows.length === 0) throw new Error('At least one quota window is required.');
  const normalizedCapturedAt = new Date(capturedAt).toISOString();
  return {
    provider,
    source,
    capturedAt: normalizedCapturedAt,
    account,
    windows: windows.map((window) => normalizeWindow(window, source, normalizedCapturedAt)),
  };
}

export function deriveAttemptBurnObservations({ snapshots = [], attempts = [], now = Date.now() } = {}) {
  const ordered = [...snapshots]
    .filter((snapshot) => snapshot?.provider === 'codex' && Number.isFinite(Date.parse(snapshot.capturedAt)))
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  const observations = [];
  for (const attempt of attempts) {
    if (attempt?.provider !== 'codex') continue;
    const startedMs = Date.parse(attempt.startedAt ?? attempt.createdAt);
    if (!Number.isFinite(startedMs)) continue;
    const running = ['running', 'stopping'].includes(attempt.status);
    const finishedMs = Date.parse(attempt.finishedAt ?? attempt.completedAt ?? attempt.endedAt);
    if (!running && !Number.isFinite(finishedMs)) continue;
    if (!running && !['completed', 'interrupted'].includes(attempt.status)) continue;
    const endTargetMs = running
      ? Math.min(now, Date.parse(ordered.at(-1)?.capturedAt ?? ''))
      : finishedMs;
    if (!Number.isFinite(endTargetMs) || endTargetMs <= startedMs) continue;
    const before = nearestSnapshot(ordered, startedMs, attempt.provider);
    const after = running
      ? ordered.findLast((snapshot) => snapshot.provider === attempt.provider) ?? null
      : nearestSnapshot(ordered, endTargetMs, attempt.provider);
    if (!before || !after || before === after) continue;
    const elapsedMinutes = (Date.parse(after.capturedAt) - Date.parse(before.capturedAt)) / 60_000;
    if (elapsedMinutes < MIN_ATTEMPT_SAMPLE_MINUTES || elapsedMinutes > MAX_ATTEMPT_SAMPLE_MINUTES) continue;
    const planType = accountProfileAt(ordered, Date.parse(before.capturedAt), attempt.provider);
    if (planType !== accountProfileAt(ordered, Date.parse(after.capturedAt), attempt.provider)) continue;

    for (const previous of before.windows ?? []) {
      const current = (after.windows ?? []).find((candidate) =>
        candidate.id === previous.id
        && candidate.windowMinutes === previous.windowMinutes
        && candidate.resetsAt === previous.resetsAt);
      if (!current) continue;
      const usedDelta = Number(current.usedPercent) - Number(previous.usedPercent);
      if (!Number.isFinite(usedDelta) || usedDelta < 0 || usedDelta > 100) continue;
      const roundingUncertainty = (percentageStep(previous.usedPercent) + percentageStep(current.usedPercent)) / 2;
      const percentPerMinute = (usedDelta + roundingUncertainty) / elapsedMinutes;
      if (!Number.isFinite(percentPerMinute) || percentPerMinute <= 0) continue;
      observations.push({
        provider: attempt.provider,
        windowMinutes: current.windowMinutes,
        resetsAt: current.resetsAt,
        observedAt: after.capturedAt,
        attemptId: attempt.id ?? attempt.attemptId,
        model: profileToken(attempt.model),
        effort: profileToken(attempt.effort),
        planType,
        sampleMinutes: elapsedMinutes,
        usedPercent: usedDelta,
        roundingUncertainty,
        elapsedMinutes,
        percentPerMinute,
      });
    }
  }
  return observations;
}

export function deriveBurnObservations(snapshots, attempts = [], options = {}) {
  return deriveAttemptBurnObservations({ snapshots, attempts, ...options });
}

export function estimateQuota({
  snapshot,
  observations = [],
  riskMode = 'balanced',
  keepPercent = 10,
  model = null,
  now = Date.now(),
}) {
  const mode = RISK_MODES[riskMode];
  if (!mode) return blocked('Unknown risk mode.');
  if (!snapshot) return blocked('No quota snapshot is available.');
  const capturedAt = Date.parse(snapshot.capturedAt);
  if (!Number.isFinite(capturedAt) || capturedAt - now > 60_000 || now - capturedAt > SNAPSHOT_MAX_AGE_MS) {
    return blocked('Quota data is stale. Refresh every active meter before starting.');
  }
  if (!Array.isArray(snapshot.windows) || snapshot.windows.length === 0) {
    return blocked('No active quota windows were supplied.');
  }

  const reservePercent = Math.max(mode.reservePercent, clamp(Number(keepPercent), 0, 95));
  const estimates = [];
  const planType = accountProfile(snapshot);
  const selectedModel = profileToken(model);

  for (const window of snapshot.windows) {
    const windowCapturedAt = Date.parse(window.capturedAt ?? snapshot.capturedAt);
    if (!Number.isFinite(windowCapturedAt) || windowCapturedAt - now > 60_000 || now - windowCapturedAt > SNAPSHOT_MAX_AGE_MS) {
      return blocked(`${window.label} data is stale. Refresh every active meter before starting.`);
    }
    const resetAt = Date.parse(window.resetsAt);
    const untilReset = Math.floor((resetAt - now) / 60_000) - RESET_MARGIN_MINUTES;
    const roundingMargin = snapshot.source.startsWith('manual') ? 1 : 0.25;
    const safePercent = Math.max(0, window.remainingPercent - reservePercent - roundingMargin);
    if (window.reachedType || window.status === 'rejected') {
      return blocked(`${window.label} is already rate limited.`);
    }
    if (untilReset < mode.calibrationMinutes) {
      return blocked(`${window.label} resets too soon for a safe checkpoint.`);
    }
    if (safePercent <= 0) {
      return blocked(`${window.label} has no allowance above the ${reservePercent}% reserve.`);
    }

    const profile = observations
      .filter((item) => item.provider === snapshot.provider
        && item.windowMinutes === window.windowMinutes
        && item.planType === planType
        && (!selectedModel || item.model === selectedModel)
        && Number.isFinite(item.percentPerMinute)
        && item.percentPerMinute > 0
        && Number.isFinite(item.sampleMinutes)
        && item.sampleMinutes >= MIN_ATTEMPT_SAMPLE_MINUTES
        && Number.isFinite(Date.parse(item.observedAt))
        && now - Date.parse(item.observedAt) <= PROFILE_MAX_AGE_MS)
      .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
      .slice(-PROFILE_MAX_RUNS);
    const learned = profile.length > 0;
    const profileRate = learned ? weightedPercentile(profile, PROFILE_PERCENTILE) : null;
    const burnRate = learned ? profileRate * mode.burnMultiplier : null;
    const calibrationMinutes = safePercent >= CALIBRATION_MIN_SAFE_PERCENT
      ? CALIBRATION_RUN_MINUTES
      : mode.calibrationMinutes;
    const quotaMinutes = learned ? Math.floor(safePercent / burnRate) : calibrationMinutes;
    estimates.push({
      id: window.id,
      label: window.label,
      remainingPercent: window.remainingPercent,
      resetsAt: window.resetsAt,
      safePercent,
      burnPercentPerMinute: burnRate,
      observations: profile.length,
      observedMinutes: profile.reduce((sum, item) => sum + item.sampleMinutes, 0),
      calibration: !learned,
      allowedMinutes: Math.max(0, Math.min(quotaMinutes, untilReset, mode.maxMinutes)),
    });
  }

  const allowedMinutes = Math.min(...estimates.map((item) => item.allowedMinutes));
  if (allowedMinutes < 1) return blocked('The tightest quota window cannot fund another safe slice.');
  const observationCount = Math.min(...estimates.map((item) => item.observations));
  const calibration = estimates.some((item) => item.calibration);
  const confidence = calibration ? 'calibration' : observationCount >= 3 ? 'medium' : 'low';
  const bottleneck = estimates.reduce((lowest, item) => item.allowedMinutes < lowest.allowedMinutes ? item : lowest);
  return {
    status: 'ready',
    allowedMinutes,
    checkpointMinutes: Math.min(mode.checkpointMinutes, allowedMinutes),
    reservePercent,
    calibration,
    confidence,
    bottleneck: bottleneck.label,
    reason: calibration
      ? allowedMinutes >= CALIBRATION_RUN_MINUTES
        ? 'No comparable whole-run profile exists for every active meter, so Millennium allows one monitored fifteen-minute calibration run.'
        : 'No comparable whole-run profile exists, and the allowance above reserve is too small for a fifteen-minute calibration run.'
      : `${bottleneck.label} is the tightest active meter using comparable whole Millennium runs and a conservative rounding margin.`,
    windows: estimates,
  };
}

export function labelForWindow(windowMinutes) {
  if (Math.abs(windowMinutes - 300) <= 5) return '5-hour window';
  if (Math.abs(windowMinutes - 10_080) <= 60) return 'Weekly window';
  if (windowMinutes < 180) return `${Math.round(windowMinutes)}-minute window`;
  if (windowMinutes < 2_880) return `${Math.round(windowMinutes / 60)}-hour window`;
  return `${Math.round(windowMinutes / 1_440)}-day window`;
}

function blocked(reason) {
  return { status: 'blocked', allowedMinutes: 0, reason, confidence: 'none', windows: [] };
}

function nearestSnapshot(snapshots, targetMs, provider) {
  let nearest = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const snapshot of snapshots) {
    if (snapshot.provider !== provider) continue;
    const candidateDistance = Math.abs(Date.parse(snapshot.capturedAt) - targetMs);
    if (candidateDistance > ATTEMPT_BOUNDARY_TOLERANCE_MS || candidateDistance >= distance) continue;
    nearest = snapshot;
    distance = candidateDistance;
  }
  return nearest;
}

function weightedPercentile(observations, target) {
  const ordered = [...observations].sort((left, right) => left.percentPerMinute - right.percentPerMinute);
  const totalWeight = ordered.reduce((sum, item) => sum + Math.min(MAX_ATTEMPT_SAMPLE_MINUTES, item.sampleMinutes), 0);
  const threshold = totalWeight * target;
  let accumulated = 0;
  for (const observation of ordered) {
    accumulated += Math.min(MAX_ATTEMPT_SAMPLE_MINUTES, observation.sampleMinutes);
    if (accumulated >= threshold) return observation.percentPerMinute;
  }
  return ordered.at(-1)?.percentPerMinute ?? 0;
}

function percentageStep(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  const text = String(value).toLowerCase();
  if (text.includes('e-')) {
    const exponent = Number(text.split('e-')[1]);
    return Number.isFinite(exponent) ? 10 ** -Math.min(6, exponent) : 1;
  }
  const decimals = text.includes('.') ? text.split('.')[1].length : 0;
  return 10 ** -Math.min(6, decimals);
}

function accountProfile(snapshot) {
  return profileToken(snapshot?.account?.planType) || 'unknown';
}

function accountProfileAt(snapshots, targetMs, provider) {
  let profile = 'unknown';
  for (const snapshot of snapshots) {
    const capturedMs = Date.parse(snapshot.capturedAt);
    if (snapshot.provider !== provider || capturedMs > targetMs) continue;
    const candidate = accountProfile(snapshot);
    if (candidate !== 'unknown') profile = candidate;
  }
  return profile;
}

function profileToken(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().slice(0, 160) : '';
}

function finite(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}
