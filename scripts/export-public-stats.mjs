import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { validateContributionPath, validateContributionRecord } from './contribution-contract.mjs';

export const PROBLEM_CATALOG = Object.freeze([
  { id: 'riemann-hypothesis', contribution_id: 'riemann-hypothesis', ui_slug: 'rh' },
  { id: 'p-vs-np', contribution_id: 'p-vs-np', ui_slug: 'pnp' },
  { id: 'navier-stokes', contribution_id: 'navier-stokes', ui_slug: 'ns' },
  { id: 'hodge-conjecture', contribution_id: 'hodge-conjecture', ui_slug: 'hodge' },
  { id: 'birch-swinnerton-dyer', contribution_id: 'birch-swinnerton-dyer', ui_slug: 'bsd' },
  { id: 'yang-mills', contribution_id: 'yang-mills-mass-gap', ui_slug: 'ym' },
  { id: 'poincare-conjecture', contribution_id: 'poincare-conjecture', ui_slug: 'pc' },
]);

const DATA_SCOPE = 'validated canonical contribution records on public main';
const MAX_RECORD_BYTES = 96 * 1024;

function fail(message) {
  throw new Error(`Public stats export rejected: ${message}`);
}

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function resolveAttemptsRoot(source = path.join('contributions', 'attempts')) {
  const resolved = path.resolve(source);
  const nested = path.join(resolved, 'contributions', 'attempts');
  const candidate = await exists(nested) ? nested : resolved;
  const root = await fs.realpath(candidate).catch(() => fail('the source directory does not exist'));
  const info = await fs.stat(root);
  if (!info.isDirectory()) fail('the source must resolve to a contribution directory');
  return root;
}

async function discoverManifests(root) {
  const manifests = [];

  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(candidate);
      else if (entry.isFile() && entry.name.endsWith('.json')) manifests.push(candidate);
    }
  }

  await walk(root);
  return manifests;
}

function parseManifest(text, relativePath) {
  try { return validateContributionRecord(JSON.parse(text)); }
  catch (error) { fail(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`); }
}

function validateManifest(manifest, relativePath) {
  validateContributionPath(`contributions/attempts/${relativePath.replaceAll(path.sep, '/')}`, manifest);
  return {
    attemptId: manifest.attempt_id,
    problem: manifest.problem,
    state: manifest.status === 'completed' ? 'completed' : 'aborted',
  };
}

export async function buildPublicDashboard({ source, generatedAt = new Date().toISOString() }) {
  if (Number.isNaN(Date.parse(generatedAt))) fail('generatedAt must be an ISO-compatible date');
  const root = await resolveAttemptsRoot(source);
  const manifestPaths = await discoverManifests(root);
  const seenIds = new Set();
  const records = [];

  for (const manifestPath of manifestPaths) {
    const relativePath = path.relative(root, manifestPath);
    if ((await fs.stat(manifestPath)).size > MAX_RECORD_BYTES) fail(`${relativePath} is too large`);
    const text = await fs.readFile(manifestPath, 'utf8');
    const record = validateManifest(parseManifest(text, relativePath), relativePath);
    if (seenIds.has(record.attemptId)) fail(`${relativePath} duplicates an attempt_id`);
    seenIds.add(record.attemptId);
    records.push(record);
  }

  const problems = PROBLEM_CATALOG.map(({ id, contribution_id, ui_slug }) => {
    const matching = records.filter((record) => record.problem === contribution_id);
    return {
      id,
      ui_slug,
      runs: matching.length,
      completed: matching.filter(({ state }) => state === 'completed').length,
      checkpointed: matching.filter(({ state }) => state === 'checkpointed').length,
      aborted: matching.filter(({ state }) => state === 'aborted').length,
    };
  });

  return {
    schema_version: 1,
    generated_at: new Date(generatedAt).toISOString(),
    data_scope: DATA_SCOPE,
    totals: {
      runs: records.length,
      completed: records.filter(({ state }) => state === 'completed').length,
      checkpointed: records.filter(({ state }) => state === 'checkpointed').length,
      aborted: records.filter(({ state }) => state === 'aborted').length,
    },
    problems,
  };
}

function parseArguments(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!['--source', '--output', '--generated-at'].includes(current)) fail(`unknown argument ${current}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`${current} requires a value`);
    args[current.slice(2)] = value;
    index += 1;
  }
  return args;
}

export async function runCli(argv) {
  const args = parseArguments(argv);
  const output = path.resolve(args.output ?? path.join('public', 'data', 'dashboard.v1.json'));
  const dashboard = await buildPublicDashboard({
    source: args.source ?? path.join('contributions', 'attempts'),
    generatedAt: args['generated-at'] ?? new Date().toISOString(),
  });
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(dashboard, null, 2)}\n`, 'utf8');
  process.stdout.write(`Published ${dashboard.totals.runs} aggregate run(s) to ${output}\n`);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
