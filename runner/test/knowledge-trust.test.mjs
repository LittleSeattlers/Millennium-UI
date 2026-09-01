import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildContributionRecord, contributionPath } from '../../scripts/contribution-contract.mjs';
import { loadSharedContributionRecords } from '../knowledge.mjs';

test('shared contribution prose stays quarantined until its attempt id is trusted', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'millennium-knowledge-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const record = buildContributionRecord({
    attempt: {
      id: 'navier-stokes-2026-08-29-00000000-0000-4000-8000-000000000777',
      problem: 'navier-stokes',
      problemId: 'ns',
      direction: 'blowup',
      route: 'refute-or-search-witness',
      status: 'completed',
      startedAt: '2026-08-29T08:00:00.000Z',
      finishedAt: '2026-08-29T08:05:00.000Z',
      parentAttemptIds: [],
      researchTask: { taskId: 'ns.blowup.seed-task', branchId: 'seed', mode: 'frontier', kind: 'computation', title: 'Test one bounded diagnostic' },
    },
    proposal: {
      summary: 'The bounded diagnostic produced one reusable but still unreviewed mathematical observation.',
      claims: [],
      limitations: ['This fixture does not establish finite-time breakdown or global regularity.'],
      failed_approaches: [],
      next_actions: [],
      proposed_tasks: [],
      citations: [],
    },
  });
  const repository = path.join(root, 'repo');
  const contributionsRoot = path.join(repository, 'contributions', 'attempts');
  const destination = path.join(repository, ...contributionPath(record).split('/'));
  const trustFile = path.join(repository, 'research', 'trusted-contributions.v1.json');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.mkdir(path.dirname(trustFile), { recursive: true });
  await fs.writeFile(destination, `${JSON.stringify(record, null, 2)}\n`);
  await fs.writeFile(trustFile, '{"schemaVersion":1,"attemptIds":[]}\n');

  const quarantined = await loadSharedContributionRecords({ contributionsRoot, trustFile });
  assert.equal(quarantined[0]?.recordSource, 'shared-contribution-quarantined');

  await fs.writeFile(trustFile, `${JSON.stringify({ schemaVersion: 1, attemptIds: [record.attempt_id] })}\n`);
  const trusted = await loadSharedContributionRecords({ contributionsRoot, trustFile });
  assert.equal(trusted[0]?.recordSource, 'shared-contribution-trusted');
});
