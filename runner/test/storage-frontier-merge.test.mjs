import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeResearchRecords } from '../storage.mjs';

function localAttempt(overrides = {}) {
  return {
    attemptId: 'navier-stokes-local-attempt-0001',
    problem: 'navier-stokes',
    direction: 'blowup',
    startedAt: '2026-09-05T10:00:00.000Z',
    researchTask: { taskId: 'auto.slice.v1.0123456789abcdef', branchId: 'certificate' },
    researchValue: { status: 'accepted', outcome: 'frontier-refinement' },
    publication: { status: 'submitted' },
    proposedTasks: [],
    ...overrides,
  };
}

function repositoryAttempt(overrides = {}) {
  return {
    attemptId: 'navier-stokes-local-attempt-0001',
    problem: 'navier-stokes',
    direction: 'blowup',
    startedAt: '2026-09-05T10:00:00.000Z',
    researchTask: { taskId: 'auto.slice.v1.0123456789abcdef', branchId: 'certificate' },
    proposedTasks: [{ id: 'community.0123456789abcdef', title: 'Test one concrete successor' }],
    recordSource: 'shared-contribution-quarantined',
    ...overrides,
  };
}

test('legacy accepted local attempts recover their own validated repository proposals', () => {
  const [merged] = mergeResearchRecords({
    local: [localAttempt()],
    contributions: [repositoryAttempt()],
  });
  assert.equal(merged.recordSource, 'local');
  assert.deepEqual(merged.proposedTasks, repositoryAttempt().proposedTasks);
});

test('repository proposals cannot attach to an unaccepted or mismatched local attempt', () => {
  for (const local of [
    localAttempt({ researchValue: { status: 'insufficient' } }),
    localAttempt({ publication: { status: 'failed' } }),
    localAttempt({ researchTask: { taskId: 'different.task', branchId: 'certificate' } }),
  ]) {
    const [merged] = mergeResearchRecords({ local: [local], contributions: [repositoryAttempt()] });
    assert.deepEqual(merged.proposedTasks, []);
  }
});

test('new local proposal state takes precedence over the repository migration fallback', () => {
  const current = [{ id: 'community.current0000001', title: 'Use the current local successor' }];
  const [merged] = mergeResearchRecords({
    local: [localAttempt({ proposedTasks: current })],
    contributions: [repositoryAttempt()],
  });
  assert.deepEqual(merged.proposedTasks, current);
});
