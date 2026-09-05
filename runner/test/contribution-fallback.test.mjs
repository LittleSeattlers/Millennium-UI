import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPreparedContribution } from '../contribution.mjs';

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

test('unavailable and rejected proposals are withheld instead of publishing filler', () => {
  const missing = buildPreparedContribution({
    attempt: attempt(),
    proposal: {},
    warning: 'Structured contribution was unavailable: missing file.',
  });
  assert.equal(missing.publishable, false);
  assert.equal(missing.usedProposal, false);
  assert.equal(missing.record, null);
  assert.match(missing.warning, /task remains open/i);

  const rejected = buildPreparedContribution({
    attempt: attempt({ status: 'failed', result: '' }),
    proposal: { summary: 'too short' },
  });
  assert.equal(rejected.publishable, false);
  assert.equal(rejected.usedProposal, false);
  assert.equal(rejected.record, null);
  assert.match(rejected.warning, /Structured contribution was rejected/);
});

test('a contract-valid evidence-bearing proposal remains publishable', () => {
  const prepared = buildPreparedContribution({
    attempt: attempt(),
    proposal: {
      summary: 'The bounded parameter check ruled out one declared range without claiming general breakdown.',
      value_assessment: {
        outcome: 'bounded-negative',
        novelty: 'This is the first stored exact check of the declared parameter range.',
        evidence: 'Exact arithmetic checked every member of the finite declared parameter range.',
        falsifier: 'Any exact member of that range violating the recorded bound would refute the result.',
      },
      claims: [{
        statement: 'Every point in the declared finite parameter range satisfies the diagnostic bound.',
        confidence: 'computational',
        evidence_summary: 'Exact arithmetic evaluated the complete declared finite parameter range.',
        verification_method: 'Enumerate the same range independently and compare every exact result.',
      }],
      limitations: ['The finite parameter range does not represent all smooth three-dimensional flows.'],
      failed_approaches: [],
      next_actions: ['Extend the exact check to the next disjoint parameter range and compare the boundary case.'],
      proposed_tasks: [],
      citations: [],
    },
  });
  assert.equal(prepared.publishable, true);
  assert.equal(prepared.usedProposal, true);
  assert.equal(prepared.record?.value_assessment.outcome, 'bounded-negative');
});

test('unsafe contributor prose is withheld rather than reconstructed into a public record', () => {
  const recovered = buildPreparedContribution({
    attempt: attempt({
      objective: 'Contact researcher@example.com about the local artifact before continuing.',
      result: 'Private follow-up belongs at researcher@example.com and must not be published.',
      limitations: 'The private contact detail is not research evidence.',
    }),
    proposal: { summary: 'too short' },
  });

  assert.equal(recovered.publishable, false);
  assert.equal(recovered.usedProposal, false);
  assert.equal(recovered.record, null);
  assert.doesNotMatch(recovered.warning, /researcher@example\.com/);
  assert.match(recovered.warning, /task remains open/i);
});
