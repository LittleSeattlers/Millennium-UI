import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AttemptManager,
  finalizationDelayMs,
  requireUsefulRunMinutes,
  shouldCompleteFromDurableDeadline,
} from '../attempts.mjs';
import {
  FINALIZATION_RESERVE_MINUTES,
  MIN_USEFUL_RUN_MINUTES,
} from '../constants.mjs';
import { HttpError } from '../security.mjs';

test('a sub-fifteen-minute request is rejected before provider or claim work starts', async () => {
  const manager = new AttemptManager();
  await assert.rejects(
    manager.start({
      provider: 'codex',
      problemId: 'rh',
      direction: 'prove',
      requestedMinutes: 14,
      objective: 'Test one explicit bounded consequence of the hypothesis.',
    }),
    (error) => error instanceof HttpError
      && error.code === 'insufficient_safe_time'
      && /No Codex research run was started/.test(error.message),
  );
  assert.equal(manager.health().starting, false);
  assert.equal(manager.health().activeAttemptId, null);
});

test('the useful-run gate admits fifteen minutes and rejects smaller safe estimates', () => {
  assert.equal(MIN_USEFUL_RUN_MINUTES, 15);
  assert.equal(requireUsefulRunMinutes(15), 15);
  assert.throws(
    () => requireUsefulRunMinutes(14),
    (error) => error instanceof HttpError && error.code === 'insufficient_safe_time',
  );
});

test('reserved finalization begins exactly four minutes before the absolute deadline', () => {
  assert.equal(FINALIZATION_RESERVE_MINUTES, 4);
  const deadlineMs = 1_000_000;
  assert.equal(finalizationDelayMs(deadlineMs, deadlineMs - 5 * 60_000), 60_000);
  assert.equal(finalizationDelayMs(deadlineMs, deadlineMs - 4 * 60_000), 0);
  assert.equal(finalizationDelayMs(deadlineMs, deadlineMs - 90_000), -150_000);
});

test('a safe-deadline interruption is completed only with a validated structured contribution', () => {
  const valid = {
    publishable: true,
    usedProposal: true,
    record: { attempt_id: 'attempt-1' },
  };
  assert.equal(shouldCompleteFromDurableDeadline({
    status: 'interrupted',
    disposition: 'time-limit',
    prepared: valid,
  }), true);
  assert.equal(shouldCompleteFromDurableDeadline({
    status: 'interrupted',
    disposition: 'user-stopped',
    prepared: valid,
  }), false);
  assert.equal(shouldCompleteFromDurableDeadline({
    status: 'interrupted',
    disposition: 'time-limit',
    prepared: { ...valid, publishable: false, record: null },
  }), false);
});
