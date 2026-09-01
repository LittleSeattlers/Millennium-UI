import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFallbackProposal, buildPreparedContribution } from '../contribution.mjs';

function attempt(overrides = {}) {
  return {
    id: 'navier-stokes-2026-08-31-00000000-0000-4000-8000-000000000124',
    problem: 'navier-stokes',
    problemId: 'ns',
    direction: 'blowup',
    route: 'refute-or-search-witness',
    status: 'interrupted',
    startedAt: '2026-08-31T08:00:00.000Z',
    finishedAt: '2026-08-31T08:05:00.000Z',
    objective: 'Test whether one finite-dimensional diagnostic can exhibit the proposed growth mechanism.',
    result: 'The persisted result ruled out one parameter range but did not establish finite-time breakdown.',
    limitations: 'The inspected parameter range is finite and cannot establish a statement about all smooth flows.',
    checkpointCount: 2,
    parentAttemptIds: [],
    researchTask: {
      taskId: 'ns.blowup.fallback-test',
      branchId: 'fallback-test',
      mode: 'frontier',
      kind: 'computation',
      title: 'Test one bounded growth diagnostic',
    },
    ...overrides,
  };
}

test('fallback proposal uses persisted result and metadata without inventing research content', () => {
  const proposal = buildFallbackProposal(attempt());
  assert.match(proposal.summary, /persisted result ruled out one parameter range/);
  assert.deepEqual(proposal.claims, []);
  assert.deepEqual(proposal.failed_approaches, []);
  assert.deepEqual(proposal.proposed_tasks, []);
  assert.deepEqual(proposal.citations, []);
  assert.match(proposal.limitations.join(' '), /interrupted attempt/);
  assert.match(proposal.limitations.join(' '), /2 durable checkpoints/);
  assert.match(proposal.next_actions[0], /verify or resume/);
  assert.match(proposal.next_actions[0], /finite-dimensional diagnostic/);
});

test('unavailable and rejected proposals produce a valid attempt-specific fallback record', () => {
  const missing = buildPreparedContribution({
    attempt: attempt(),
    proposal: {},
    warning: 'Structured contribution was unavailable: missing file.',
  });
  assert.equal(missing.usedProposal, false);
  assert.equal(missing.record.status, 'interrupted');
  assert.match(missing.record.summary, /persisted result ruled out one parameter range/);
  assert.deepEqual(missing.record.claims, []);

  const rejected = buildPreparedContribution({
    attempt: attempt({ status: 'failed', result: '' }),
    proposal: { summary: 'too short' },
  });
  assert.equal(rejected.usedProposal, false);
  assert.equal(rejected.record.status, 'failed');
  assert.match(rejected.record.summary, /status failed/);
  assert.match(rejected.warning, /Structured contribution was rejected/);
});

test('last-resort recovery drops unsafe contributor prose instead of failing publication', () => {
  const recovered = buildPreparedContribution({
    attempt: attempt({
      objective: 'Contact researcher@example.com about the local artifact before continuing.',
      result: 'Private follow-up belongs at researcher@example.com and must not be published.',
      limitations: 'The private contact detail is not research evidence.',
    }),
    proposal: { summary: 'too short' },
  });

  assert.equal(recovered.usedProposal, false);
  assert.equal(recovered.record.status, 'interrupted');
  assert.doesNotMatch(JSON.stringify(recovered.record), /researcher@example\.com/);
  assert.match(recovered.warning, /only runner-owned attempt metadata was used/);
});
