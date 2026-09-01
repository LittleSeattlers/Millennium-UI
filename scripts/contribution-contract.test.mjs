import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildContributionRecord,
  contributionPath,
  validateContributionRecord,
} from './contribution-contract.mjs';
import { validateContributionPullRequest } from './validate-contribution-pr.mjs';

function attempt() {
  return {
    id: 'navier-stokes-2026-08-29-00000000-0000-4000-8000-000000000001',
    problem: 'navier-stokes',
    problemId: 'ns',
    direction: 'blowup',
    route: 'refute-or-search-witness',
    status: 'completed',
    startedAt: '2026-08-29T08:00:00.000Z',
    finishedAt: '2026-08-29T08:05:00.000Z',
    parentAttemptIds: [],
    researchTask: {
      taskId: 'ns.blowup.test-task',
      branchId: 'adversarial-search',
      mode: 'frontier',
      kind: 'computation',
      title: 'Test a bounded blow-up diagnostic',
    },
  };
}

function proposal() {
  return {
    summary: 'The bounded check isolated one necessary condition but did not establish finite-time breakdown.',
    claims: [{
      statement: 'Within the stated finite-dimensional ansatz, the diagnostic quantity remained bounded.',
      confidence: 'computational',
      evidence_summary: 'Exact rational arithmetic reproduced the bounded diagnostic on every enumerated case.',
      verification_method: 'Reimplement the recurrence and compare the exact rational sequence term by term.',
    }],
    limitations: ['The finite-dimensional ansatz does not represent all smooth three-dimensional flows.'],
    failed_approaches: ['A floating-point scan was discarded because it lacked certified error bounds.'],
    next_actions: ['Derive an interval-certified version of the diagnostic for a larger ansatz family.'],
    proposed_tasks: [],
    citations: [{ title: 'Clay problem description', url: 'https://www.claymath.org/millennium-problems/' }],
  };
}

test('builds a strict contribution and validates its canonical path', () => {
  const record = buildContributionRecord({ attempt: attempt(), proposal: proposal() });
  assert.equal(validateContributionRecord(record), record);
  assert.equal(contributionPath(record), `contributions/attempts/navier-stokes/2026/${record.attempt_id}.json`);
});

test('rejects private paths and unsupported fields', () => {
  const unsafe = proposal();
  unsafe.summary = 'Read C:\\Users\\Somebody\\secret.txt before continuing this bounded research task.';
  assert.throws(() => buildContributionRecord({ attempt: attempt(), proposal: unsafe }), /private or credential-like/);

  const record = buildContributionRecord({ attempt: attempt(), proposal: proposal() });
  assert.throws(() => validateContributionRecord({ ...record, contributor: 'private-person' }), /unsupported field contributor/);

  const credential = proposal();
  credential.summary = 'A bounded result accidentally included credential material AKIAABCDEFGHIJKLMNOP and must be rejected.';
  assert.throws(() => buildContributionRecord({ attempt: attempt(), proposal: credential }), /credential-like/);

  const citationLeak = proposal();
  citationLeak.citations = [{ title: 'Unsafe source', url: 'https://example.com/source?leak=ghp_abcdefghijklmnopqrstuvwxyz123456' }];
  assert.throws(() => buildContributionRecord({ attempt: attempt(), proposal: citationLeak }), /credential-like/);

  const privateCitation = proposal();
  privateCitation.citations = [{ title: 'Private source', url: 'http://172.20.0.1/internal' }];
  assert.throws(() => buildContributionRecord({ attempt: attempt(), proposal: privateCitation }), /private host/);
});

test('PR validator accepts one added contribution and rejects code changes', () => {
  const record = buildContributionRecord({ attempt: attempt(), proposal: proposal() });
  const accepted = validateContributionPullRequest({
    draft: false,
    files: [{
      filename: contributionPath(record),
      status: 'added',
      encoding: 'base64',
      content: Buffer.from(`${JSON.stringify(record, null, 2)}\n`).toString('base64'),
    }],
  });
  assert.equal(accepted.attemptId, record.attempt_id);
  const canonical = `${JSON.stringify(record, null, 2)}\n`;
  const duplicateKey = canonical.replace(
    '  "summary":',
    '  "summary": "Credential-shaped material ghp_abcdefghijklmnopqrstuvwxyz123456",\n  "summary":',
  );
  assert.throws(() => validateContributionPullRequest({
    draft: false,
    files: [{
      filename: contributionPath(record),
      status: 'added',
      encoding: 'base64',
      content: Buffer.from(duplicateKey).toString('base64'),
    }],
  }), /canonical serialization/);
  assert.throws(() => validateContributionPullRequest({
    draft: false,
    files: [
      { filename: contributionPath(record), status: 'added', encoding: 'base64', content: Buffer.from(`${JSON.stringify(record, null, 2)}\n`).toString('base64') },
      { filename: 'runner/attempts.mjs', status: 'modified' },
    ],
  }), /exactly one file/);
});
