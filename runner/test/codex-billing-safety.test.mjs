import assert from 'node:assert/strict';
import test from 'node:test';
import { codexPaidFallbackRisk } from '../providers/codex.mjs';

function limits(credits, overrides = {}) {
  return {
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        credits,
        ...overrides,
      },
    },
  };
}

test('allows a verified zero-credit account when Codex omits the numeric balance', () => {
  // This is the current App Server shape for a Free plan: no credits are
  // available, but `balance` is null rather than a numeric zero.
  assert.equal(codexPaidFallbackRisk(limits({
    hasCredits: false,
    unlimited: false,
    balance: null,
  })), null);
});

test('continues to block explicit or ambiguous credit-backed states', () => {
  assert.match(codexPaidFallbackRisk(limits({
    hasCredits: true,
    unlimited: false,
    balance: 0,
  })) ?? '', /credit fallback/i);
  assert.match(codexPaidFallbackRisk(limits({
    hasCredits: false,
    unlimited: true,
    balance: null,
  })) ?? '', /credit fallback/i);
  assert.match(codexPaidFallbackRisk(limits({
    hasCredits: false,
    unlimited: false,
    balance: 3,
  })) ?? '', /credit fallback/i);
  assert.match(codexPaidFallbackRisk(limits({})) ?? '', /credit fallback/i);
});

test('continues to block workspace spend-control states', () => {
  assert.match(codexPaidFallbackRisk(limits(null, { individualLimit: 25 })) ?? '', /spend-control/i);
  assert.match(codexPaidFallbackRisk(limits(null, { spendControlReached: true })) ?? '', /spend control was reached/i);
});
