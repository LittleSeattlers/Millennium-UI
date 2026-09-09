import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveAttemptBurnObservations, estimateQuota } from '../quota.mjs';

const NOW = Date.parse('2026-09-08T17:10:00.000Z');
const RESET = '2026-09-08T20:10:00.000Z';
const WEEKLY_RESET = '2026-09-15T17:10:00.000Z';

function snapshot(capturedAt, usedPercent, { planType = 'plus', weeklyUsedPercent = 11 } = {}) {
  return {
    provider: 'codex',
    source: 'codex-account-rate-limits',
    capturedAt,
    account: { planType },
    windows: [
      {
        id: 'primary',
        label: '5-hour window',
        usedPercent,
        remainingPercent: 100 - usedPercent,
        windowMinutes: 300,
        resetsAt: RESET,
        status: 'allowed',
        capturedAt,
      },
      {
        id: 'secondary',
        label: 'Weekly window',
        usedPercent: weeklyUsedPercent,
        remainingPercent: 100 - weeklyUsedPercent,
        windowMinutes: 10_080,
        resetsAt: WEEKLY_RESET,
        status: 'allowed',
        capturedAt,
      },
    ],
  };
}

function observation(overrides = {}) {
  return {
    provider: 'codex',
    windowMinutes: 300,
    observedAt: '2026-09-08T16:30:00.000Z',
    model: 'gpt-5.6-sol',
    effort: 'high',
    planType: 'plus',
    sampleMinutes: 15,
    percentPerMinute: 0.5,
    ...overrides,
  };
}

test('learns burn only from the complete Millennium attempt boundary', () => {
  const snapshots = [
    snapshot('2026-09-08T16:00:00.000Z', 70),
    snapshot('2026-09-08T16:05:00.000Z', 72),
    snapshot('2026-09-08T16:15:00.000Z', 78),
    snapshot('2026-09-08T16:16:00.000Z', 90),
  ];
  snapshots[2].account = null;
  const attempts = [{
    id: 'attempt-1',
    provider: 'codex',
    status: 'completed',
    model: 'gpt-5.6-sol',
    effort: 'high',
    startedAt: '2026-09-08T16:00:00.000Z',
    finishedAt: '2026-09-08T16:15:00.000Z',
  }];

  const observations = deriveAttemptBurnObservations({ snapshots, attempts, now: NOW });
  const primary = observations.find((item) => item.windowMinutes === 300);
  assert.equal(observations.length, 2);
  assert.equal(primary.usedPercent, 8);
  assert.equal(primary.sampleMinutes, 15);
  assert.ok(Math.abs(primary.percentPerMinute - 0.6) < 1e-9);
});

test('isolates learned rates by subscription plan and selected model', () => {
  const current = snapshot('2026-09-08T17:09:00.000Z', 73);
  const observations = [
    observation({ percentPerMinute: 0.5 }),
    observation({ planType: 'pro', percentPerMinute: 0.1 }),
    observation({ model: 'gpt-5.6-terra', percentPerMinute: 0.1 }),
    observation({ windowMinutes: 10_080, percentPerMinute: 0.02 }),
  ];
  const estimate = estimateQuota({
    snapshot: current,
    observations,
    riskMode: 'balanced',
    keepPercent: 10,
    model: 'gpt-5.6-sol',
    now: NOW,
  });

  assert.equal(estimate.status, 'ready');
  assert.equal(estimate.allowedMinutes, 26);
  assert.equal(estimate.windows[0].observations, 1);
  assert.equal(estimate.windows[0].burnPercentPerMinute, 0.625);
});

test('uses a useful monitored calibration when the plan or model has no profile', () => {
  const current = snapshot('2026-09-08T17:09:00.000Z', 73, { planType: 'pro' });
  const estimate = estimateQuota({
    snapshot: current,
    observations: [observation({ planType: 'plus' })],
    riskMode: 'balanced',
    keepPercent: 10,
    model: 'gpt-5.6-sol',
    now: NOW,
  });

  assert.equal(estimate.status, 'ready');
  assert.equal(estimate.allowedMinutes, 15);
  assert.equal(estimate.calibration, true);
});

test('does not pretend a five-minute cold estimate can fund useful research', () => {
  const current = snapshot('2026-09-08T17:09:00.000Z', 76);
  const estimate = estimateQuota({
    snapshot: current,
    observations: [],
    riskMode: 'balanced',
    keepPercent: 10,
    model: 'gpt-5.6-sol',
    now: NOW,
  });

  assert.equal(estimate.status, 'ready');
  assert.equal(estimate.allowedMinutes, 5);
  assert.equal(estimate.calibration, true);
  assert.match(estimate.reason, /too small for a fifteen-minute calibration/i);
});

test('current whole-run history funds fifteen minutes at 27 percent remaining', () => {
  const current = snapshot('2026-09-08T17:09:00.000Z', 73);
  const observations = [
    observation({ observedAt: '2026-09-01T12:00:00.000Z', sampleMinutes: 5.29, percentPerMinute: 0.946 }),
    observation({ observedAt: '2026-09-05T12:00:00.000Z', sampleMinutes: 6.98, percentPerMinute: 0.859 }),
    observation({ observedAt: '2026-09-08T16:30:00.000Z', sampleMinutes: 14.97, percentPerMinute: 0.467 }),
    observation({ windowMinutes: 10_080, sampleMinutes: 15, percentPerMinute: 0.02 }),
  ];
  const estimate = estimateQuota({
    snapshot: current,
    observations,
    riskMode: 'balanced',
    keepPercent: 10,
    model: 'gpt-5.6-sol',
    now: NOW,
  });

  assert.equal(estimate.status, 'ready');
  assert.equal(estimate.allowedMinutes, 15);
  assert.equal(estimate.calibration, false);
  assert.equal(estimate.bottleneck, '5-hour window');
});
