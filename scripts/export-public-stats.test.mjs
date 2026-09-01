import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildPublicDashboard } from './export-public-stats.mjs';

async function makeRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'millennium-public-stats-'));
}

async function addContribution(root, { problem, status, id, problemId = 'ns', direction = 'regular', year = '2026' }) {
  const directory = path.join(root, problem, year);
  await fs.mkdir(directory, { recursive: true });
  const record = {
    schema_version: 1,
    attempt_id: id,
    problem,
    problem_id: problemId,
    direction,
    route: 'prove',
    status,
    started_at: `${year}-01-01T00:00:00.000Z`,
    finished_at: `${year}-01-01T00:05:00.000Z`,
    research_task: { task_id: `${problemId}.${direction}.test-task`, branch_id: 'test-branch', mode: 'frontier', kind: 'proof', title: 'Test bounded research task' },
    summary: 'A bounded test contribution with no mathematical conclusion was recorded.',
    claims: [],
    limitations: ['This fixture is unreviewed and exists only to test aggregate publication.'],
    failed_approaches: [],
    next_actions: [],
    proposed_tasks: [],
    citations: [],
    prior_attempt_ids: [],
    review_status: 'unreviewed',
  };
  await fs.writeFile(path.join(directory, `${id}.json`), `${JSON.stringify(record)}\n`, 'utf8');
}

test('exports only fixed aggregates for validated contribution records', async (t) => {
  const root = await makeRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await addContribution(root, { problem: 'navier-stokes', status: 'completed', id: 'navier-stokes-test-0001' });
  await addContribution(root, { problem: 'p-vs-np', problemId: 'pnp', direction: 'equal', status: 'interrupted', id: 'p-vs-np-test-0001' });

  const dashboard = await buildPublicDashboard({ source: root, generatedAt: '2026-08-27T00:00:00Z' });
  assert.deepEqual(dashboard.totals, { runs: 2, completed: 1, checkpointed: 0, aborted: 1 });
  assert.equal(dashboard.problems.length, 7);
  assert.equal(dashboard.problems.find(({ id }) => id === 'navier-stokes')?.runs, 1);
  assert.equal(dashboard.problems.find(({ id }) => id === 'p-vs-np')?.aborted, 1);

  const published = JSON.stringify(dashboard);
  assert.doesNotMatch(published, /test-0001|bounded test contribution|summary|claims/);
});

test('rejects unknown problem and status values instead of publishing them', async (t) => {
  const unknownProblemRoot = await makeRoot();
  const unknownStateRoot = await makeRoot();
  t.after(() => Promise.all([
    fs.rm(unknownProblemRoot, { recursive: true, force: true }),
    fs.rm(unknownStateRoot, { recursive: true, force: true }),
  ]));
  await addContribution(unknownProblemRoot, { problem: 'secret-problem', status: 'completed', id: 'secret-problem-test-0001' });
  await addContribution(unknownStateRoot, { problem: 'navier-stokes', status: 'reviewed', id: 'navier-stokes-test-0002' });

  await assert.rejects(() => buildPublicDashboard({ source: unknownProblemRoot }), /problem is unsupported|path does not match/);
  await assert.rejects(() => buildPublicDashboard({ source: unknownStateRoot }), /status is unsupported/);
});

test('rejects duplicate IDs and non-canonical layouts', async (t) => {
  const root = await makeRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await addContribution(root, { problem: 'navier-stokes', status: 'completed', id: 'navier-stokes-test-0003', year: '2026' });
  await addContribution(root, { problem: 'navier-stokes', status: 'completed', id: 'navier-stokes-test-0003', year: '2027' });

  await assert.rejects(() => buildPublicDashboard({ source: root }), /duplicates an attempt_id/);
});
