import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { LEDGER_CONTRIBUTIONS_ROOT, LEDGER_TRUST_FILE } from './constants.mjs';
import {
  stableProposedTaskId,
  validateContributionRecord,
  validateContributionPath,
} from '../scripts/contribution-contract.mjs';

const MAX_RECORDS = 10_000;
const MAX_RECORD_BYTES = 96 * 1024;

export async function loadSharedContributionRecords({
  problem = null,
  limit = 2_000,
  contributionsRoot = LEDGER_CONTRIBUTIONS_ROOT,
  trustFile = LEDGER_TRUST_FILE,
} = {}) {
  const trustedAttemptIds = await loadTrustedAttemptIds(trustFile);
  const files = [];
  await walk(contributionsRoot, contributionsRoot, files).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  const records = [];
  for (const file of files.slice(0, MAX_RECORDS)) {
    try {
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_RECORD_BYTES) continue;
      const contribution = validateContributionRecord(JSON.parse(await readFile(file, 'utf8')));
      const relativePath = path.relative(path.resolve(contributionsRoot, '..', '..'), file);
      validateContributionPath(relativePath, contribution);
      if (!problem || contribution.problem === problem) {
        records.push(toResearchRecord(contribution, trustedAttemptIds.has(contribution.attempt_id)));
      }
    } catch {
      // Main is validated before merge. A malformed local clone entry is ignored and cannot become prompt context.
    }
  }
  return records
    .sort((left, right) => Date.parse(right.finishedAt) - Date.parse(left.finishedAt))
    .slice(0, Math.max(1, Math.min(MAX_RECORDS, Number(limit) || 2_000)));
}

function toResearchRecord(record, trustedForCodex) {
  return {
    id: record.attempt_id,
    attemptId: record.attempt_id,
    problem: record.problem,
    problemSlug: record.problem,
    problemId: record.problem_id,
    problemKey: record.problem_id,
    direction: record.direction,
    routeId: record.direction,
    route: record.route,
    status: record.status,
    artifactState: record.status === 'completed' ? 'completed' : 'aborted',
    startedAt: record.started_at,
    finishedAt: record.finished_at,
    reviewStatus: record.review_status,
    disposition: record.status === 'completed' ? 'bounded-attempt-completed' : record.status,
    result: record.summary,
    summary: record.summary,
    valueAssessment: { ...record.value_assessment },
    researchValue: {
      status: 'accepted',
      outcome: record.value_assessment.outcome,
    },
    limitations: [...record.limitations],
    failedApproaches: [...record.failed_approaches],
    nextActions: [...record.next_actions],
    claims: record.claims.map((claim) => ({ ...claim })),
    citations: record.citations.map((citation) => ({ ...citation })),
    parentAttemptIds: [...record.prior_attempt_ids],
    consultedAttemptIds: [...record.prior_attempt_ids],
    researchTask: {
      taskId: record.research_task.task_id,
      branchId: record.research_task.branch_id,
      mode: record.research_task.mode,
      kind: record.research_task.kind,
      title: record.research_task.title,
    },
    proposedTasks: record.proposed_tasks.map((proposal, index) => ({
      id: stableProposedTaskId(record.attempt_id, proposal, index),
      ...proposal,
      sourceAttemptIds: [record.attempt_id],
    })),
    recordSource: trustedForCodex ? 'shared-contribution-trusted' : 'shared-contribution-quarantined',
    trustedForCodex,
  };
}

async function loadTrustedAttemptIds(trustFile) {
  try {
    const value = JSON.parse(await readFile(trustFile, 'utf8'));
    if (value?.schemaVersion !== 1 || !Array.isArray(value.attemptIds)) return new Set();
    const ids = value.attemptIds.filter((attemptId) => (
      typeof attemptId === 'string' && /^[a-z0-9][a-z0-9._-]{7,179}$/.test(attemptId)
    ));
    return ids.length === value.attemptIds.length && new Set(ids).size === ids.length
      ? new Set(ids)
      : new Set();
  } catch {
    return new Set();
  }
}

async function walk(root, directory, files) {
  if (files.length >= MAX_RECORDS) return;
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (files.length >= MAX_RECORDS || entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) continue;
    const candidate = path.resolve(directory, entry.name);
    if (!isWithin(root, candidate)) continue;
    if (entry.isDirectory()) await walk(root, candidate, files);
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(candidate);
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
