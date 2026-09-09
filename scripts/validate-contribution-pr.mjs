import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  validateContributionPath,
  validateContributionRecord,
} from './contribution-contract.mjs';

const MAX_FILE_BYTES = 96 * 1024;

export function validateContributionPullRequest(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.files)) fail('payload is invalid');
  if (payload.draft === true) fail('draft claims are not mergeable');
  if (payload.files.length !== 1) fail('a contribution PR must change exactly one file');
  const file = payload.files[0];
  if (!file || typeof file !== 'object' || file.status !== 'added') fail('the contribution file must be newly added');
  if (typeof file.filename !== 'string' || !/^contributions\/attempts\/[a-z0-9-]+\/\d{4}\/[a-z0-9._-]+\.json$/.test(file.filename)) {
    fail('the changed path is outside contributions/attempts');
  }
  if (file.encoding !== 'base64' || typeof file.content !== 'string') fail('the contribution blob is missing');
  const bytes = Buffer.from(file.content.replace(/\s+/g, ''), 'base64');
  if (bytes.length < 2 || bytes.length > MAX_FILE_BYTES) fail('the contribution blob size is invalid');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const record = validateContributionRecord(JSON.parse(text));
  const canonical = `${JSON.stringify(record, null, 2)}\n`;
  if (text !== canonical) fail('the contribution blob must use the canonical serialization');
  validateContributionPath(file.filename, record);
  return { attemptId: record.attempt_id, path: file.filename, record };
}

export async function materializeContributionPullRequest(payload, checkoutRoot) {
  const result = validateContributionPullRequest(payload);
  const root = path.resolve(checkoutRoot);
  const destination = path.resolve(root, result.path);
  const relative = path.relative(root, destination);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('the contribution path escapes the trusted checkout');
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(result.record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return result;
}

function fail(message) {
  throw new Error(`Contribution PR rejected: ${message}`);
}

async function runCli(argv) {
  const input = argv[0];
  if (!input) fail('a payload file is required');
  const options = argv.slice(1);
  if (options.length !== 0 && (options.length !== 2 || options[0] !== '--materialize-root')) fail('unsupported command arguments');
  const payload = JSON.parse(await readFile(path.resolve(input), 'utf8'));
  const result = options.length === 2
    ? await materializeContributionPullRequest(payload, options[1])
    : validateContributionPullRequest(payload);
  process.stdout.write(`Validated sanitized contribution ${result.attemptId}\n`);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
