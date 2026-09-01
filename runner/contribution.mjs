import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ATTEMPTS_ROOT,
  PRIVATE_ROOT,
  REPO_ROOT,
} from './constants.mjs';
import { sanitizePublicText } from './security.mjs';
import { getAttemptPaths } from './storage.mjs';
import { buildContributionRecord } from '../scripts/contribution-contract.mjs';

const MAX_PROPOSAL_BYTES = 64 * 1024;
const PROPOSAL_FILE = 'CONTRIBUTION.proposed.json';
const PATH_REPLACEMENTS = [
  [literalPattern(PRIVATE_ROOT), '$PRIVATE'],
  [literalPattern(ATTEMPTS_ROOT), '$ATTEMPTS'],
  [literalPattern(REPO_ROOT), '$REPOSITORY'],
];

export async function prepareContribution(attempt) {
  const paths = await getAttemptPaths(attempt.id ?? attempt.attemptId);
  const proposalFile = path.join(paths.codeDirectory, PROPOSAL_FILE);
  let proposal = {};
  let warning = null;
  try {
    const metadata = await lstat(proposalFile);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('the proposal is not a regular file');
    if (metadata.size > MAX_PROPOSAL_BYTES) throw new Error('the proposal exceeds 64 KiB');
    proposal = JSON.parse(await readFile(proposalFile, 'utf8'));
  } catch (error) {
    warning = `Structured contribution was unavailable: ${safeError(error)}.`;
  }

  return buildPreparedContribution({ attempt, proposal, warning });
}

export function buildPreparedContribution({ attempt, proposal, warning = null }) {
  const selectedProposal = warning === null ? proposal : buildFallbackProposal(attempt);
  try {
    return {
      record: buildContributionRecord({
        attempt,
        proposal: selectedProposal,
        sanitizedText: publicText,
      }),
      usedProposal: warning === null,
      warning,
    };
  } catch (error) {
    const fallbackWarning = warning === null
      ? `Structured contribution was rejected: ${safeError(error)}. A privacy-safe fallback was published instead.`
      : warning;
    let fallback = buildFallbackProposal(attempt);
    try {
      const record = buildContributionRecord({
        attempt,
        proposal: fallback,
        sanitizedText: publicText,
      });
      return { record, usedProposal: false, warning: fallbackWarning };
    } catch {
      // Persisted result prose may itself violate the strict public contract.
      // Fall back once more to runner-owned metadata rather than failing the
      // terminal publication or inventing replacement research content.
      fallback = buildFallbackProposal({
        status: attempt.status,
        checkpointCount: attempt.checkpointCount,
      });
    }
    return {
      record: buildContributionRecord({
        attempt,
        proposal: fallback,
        sanitizedText: publicText,
      }),
      usedProposal: false,
      warning: `${fallbackWarning} Persisted fallback prose did not pass the public contract, so only runner-owned attempt metadata was used.`,
    };
  }
}

export function buildFallbackProposal(attempt = {}) {
  const status = terminalStatus(attempt.status);
  const objective = fallbackText(
    attempt.objective ?? attempt.researchTask?.title,
    700,
  ) || 'the selected bounded research objective';
  const checkpointCount = Math.max(0, Math.floor(Number(attempt.checkpointCount) || 0));
  const persistedResult = fallbackText(attempt.result, 3_900);
  const recordedLimitations = fallbackText(attempt.limitations, 850);
  const statusSummary = status === 'completed'
    ? `The bounded attempt completed work on ${objective}, but it did not leave a contract-valid structured contribution.`
    : `The bounded attempt ended with status ${status} while examining ${objective}; no contract-valid structured conclusion was left.`;
  const checkpointDescription = checkpointCount === 1
    ? 'One durable checkpoint was preserved for inspection.'
    : checkpointCount > 1
      ? `${checkpointCount} durable checkpoints were preserved for inspection.`
      : 'No durable checkpoint count was recorded for this attempt.';
  const limitations = [
    `The ${status} attempt did not leave a contract-valid structured proposal, so this fallback contains no inferred mathematical claims.`,
    checkpointDescription,
  ];
  if (recordedLimitations && !limitations.includes(recordedLimitations)) limitations.push(recordedLimitations);

  return {
    summary: persistedResult.length >= 20 ? persistedResult : statusSummary,
    claims: [],
    limitations,
    failed_approaches: [],
    next_actions: [
      checkpointCount > 0
        ? `Inspect the preserved result and ${checkpointCount} checkpoint${checkpointCount === 1 ? '' : 's'}, then verify or resume this objective: ${objective}`
        : `Re-run or independently inspect the attempt before resuming this objective: ${objective}`,
    ],
    proposed_tasks: [],
    citations: [],
  };
}

function publicText(value) {
  return sanitizePublicText(value, PATH_REPLACEMENTS);
}

function literalPattern(value) {
  return new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
}

function safeError(error) {
  return publicText(error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 300);
}

function fallbackText(value, max) {
  if (value === undefined || value === null) return '';
  return publicText(String(value)).replace(/\u0000/g, '').trim().slice(0, max);
}

function terminalStatus(value) {
  return ['completed', 'interrupted', 'aborted', 'failed'].includes(value) ? value : 'failed';
}
