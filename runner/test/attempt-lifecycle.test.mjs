import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AttemptManager,
  finalizationDelayMs,
  requireUsefulRunMinutes,
} from '../attempts.mjs';
import {
  FINALIZATION_RESERVE_MINUTES,
  MIN_USEFUL_RUN_MINUTES,
} from '../constants.mjs';
import { HttpError } from '../security.mjs';

test('a sub-five-minute request is rejected before provider or claim work starts', async () => {
  const manager = new AttemptManager();
  await assert.rejects(
    manager.start({
      provider: 'codex',
      problemId: 'rh',
      direction: 'prove',
      requestedMinutes: 4,
      objective: 'Test one explicit bounded consequence of the hypothesis.',
    }),
    (error) => error instanceof HttpError
      && error.code === 'insufficient_safe_time'
      && /No Codex research run was started/.test(error.message),
  );
  assert.equal(manager.health().starting, false);
  assert.equal(manager.health().activeAttemptId, null);
});

test('the useful-run gate admits five minutes and rejects smaller safe estimates', () => {
  assert.equal(MIN_USEFUL_RUN_MINUTES, 5);
  assert.equal(requireUsefulRunMinutes(5), 5);
  assert.throws(
    () => requireUsefulRunMinutes(4),
    (error) => error instanceof HttpError && error.code === 'insufficient_safe_time',
  );
});

test('reserved finalization begins exactly two minutes before the absolute deadline', () => {
  assert.equal(FINALIZATION_RESERVE_MINUTES, 2);
  const deadlineMs = 1_000_000;
  assert.equal(finalizationDelayMs(deadlineMs, deadlineMs - 5 * 60_000), 3 * 60_000);
  assert.equal(finalizationDelayMs(deadlineMs, deadlineMs - 2 * 60_000), 0);
  assert.equal(finalizationDelayMs(deadlineMs, deadlineMs - 90_000), -30_000);
});
