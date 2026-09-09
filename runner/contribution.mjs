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
  if (warning !== null) {
    return {
      record: null,
      publishable: false,
      usedProposal: false,
      warning: `${warning} The task remains open because no contribution met the research-value contract.`,
    };
  }
  try {
    return {
      record: buildContributionRecord({
        attempt,
        proposal,
        sanitizedText: publicText,
      }),
      publishable: true,
      usedProposal: warning === null,
      warning,
    };
  } catch (error) {
    return {
      record: null,
      publishable: false,
      usedProposal: false,
      warning: `Structured contribution was rejected: ${safeError(error)}. The task remains open because no contribution met the research-value contract.`,
    };
  }
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
