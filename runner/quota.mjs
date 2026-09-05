import { RISK_MODES, SNAPSHOT_MAX_AGE_MS } from './constants.mjs';

const RESET_MARGIN_MINUTES = 2;

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

export function deriveBurnObservations(snapshots) {
  const ordered = [...snapshots].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  const observations = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const after = ordered[index];
    for (const current of after.windows ?? []) {
      let before = null;
      let previous = null;
      for (let priorIndex = index - 1; priorIndex >= 0; priorIndex -= 1) {
        const candidateSnapshot = ordered[priorIndex];
        if (candidateSnapshot.provider !== after.provider) continue;
        const candidateWindow = (candidateSnapshot.windows ?? []).find((candidate) =>
          candidate.windowMinutes === current.windowMinutes && candidate.resetsAt === current.resetsAt);
        if (candidateWindow) {
          before = candidateSnapshot;
          previous = candidateWindow;
          break;
        }
      }
      if (!previous) continue;
      const elapsedMinutes = (Date.parse(after.capturedAt) - Date.parse(before.capturedAt)) / 60_000;
      if (elapsedMinutes < 0.5 || elapsedMinutes > 360) continue;
      const usedDelta = current.usedPercent - previous.usedPercent;
      if (usedDelta <= 0 || usedDelta > 100) continue;
      observations.push({
        provider: after.provider,
        windowMinutes: current.windowMinutes,
        resetsAt: current.resetsAt,
        observedAt: after.capturedAt,
        elapsedMinutes,
        percentPerMinute: usedDelta / elapsedMinutes,
      });
    }
  }
  return observations;
}

export function estimateQuota({ snapshot, snapshots = [], riskMode = 'balanced', keepPercent = 10, now = Date.now() }) {
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
  const observations = deriveBurnObservations(snapshots);
  const estimates = [];

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

    const rates = observations
      .filter((item) => item.provider === snapshot.provider && item.windowMinutes === window.windowMinutes)
      .map((item) => item.percentPerMinute)
      .filter((value) => value > 0);
    const learned = rates.length > 0;
    const burnRate = learned ? percentile(rates, 0.95) * mode.burnMultiplier : null;
    const quotaMinutes = learned ? Math.floor(safePercent / burnRate) : mode.calibrationMinutes;
    estimates.push({
      id: window.id,
      label: window.label,
      remainingPercent: window.remainingPercent,
      resetsAt: window.resetsAt,
      safePercent,
      burnPercentPerMinute: burnRate,
      observations: rates.length,
      allowedMinutes: Math.max(0, Math.min(quotaMinutes, untilReset, mode.maxMinutes)),
    });
  }

  const allowedMinutes = Math.min(...estimates.map((item) => item.allowedMinutes));
  if (allowedMinutes < 1) return blocked('The tightest quota window cannot fund another safe slice.');
  const observationCount = Math.min(...estimates.map((item) => item.observations));
  const calibration = observationCount === 0;
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
      ? 'No same-window burn history exists yet, so the allowance is limited to a five-minute calibration estimate. Millennium will wait rather than spend it on a research run.'
      : `${bottleneck.label} is the tightest active meter using a conservative observed burn rate.`,
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

function percentile(values, target) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(target * ordered.length) - 1)];
}

function finite(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}
