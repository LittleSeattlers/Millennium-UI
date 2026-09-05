import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const RUNNER_VERSION = '0.6.0';
export const RUNNER_HOST = '127.0.0.1';
// This port is intentionally fixed and distinct from the retired private runner.
// The static hosted page must know the exact loopback address before pairing.
export const RUNNER_PORT = 4318;
export const PUBLIC_UI_ORIGIN = 'https://littleseattlers.github.io';
export const PUBLIC_UI_URL = `${PUBLIC_UI_ORIGIN}/Millennium-UI/`;
export const PUBLIC_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const MAX_JSON_BODY_BYTES = 64 * 1024;
export const MAX_PROVIDER_LINE_BYTES = 1024 * 1024;
export const MAX_PUBLIC_TEXT = 12_000;
export const SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;
export const MIN_USEFUL_RUN_MINUTES = 15;
export const FINALIZATION_RESERVE_MINUTES = 2;

const runnerDirectory = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(runnerDirectory, '..');
export const PRIVATE_ROOT = path.join(REPO_ROOT, '.millennium', 'private');
export const ATTEMPTS_ROOT = path.join(PRIVATE_ROOT, 'attempts');
export const LEDGER_ROOT = path.join(PRIVATE_ROOT, 'ledger');
export const LEDGER_CONTRIBUTIONS_ROOT = path.join(LEDGER_ROOT, 'contributions', 'attempts');
export const LEDGER_TRUST_FILE = path.join(LEDGER_ROOT, 'research', 'trusted-contributions.v1.json');
export const PUBLISH_ROOT = path.join(PRIVATE_ROOT, 'publisher');
export const UPSTREAM_REPOSITORY = 'LittleSeattlers/Millennium-UI';
export const UPSTREAM_CLONE_URL = `https://github.com/${UPSTREAM_REPOSITORY}.git`;
export const UPSTREAM_WEB_URL = `https://github.com/${UPSTREAM_REPOSITORY}`;

export const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

export const RISK_MODES = Object.freeze({
  protect: {
    label: 'Protect',
    reservePercent: 15,
    maxMinutes: 45,
    checkpointMinutes: 5,
    calibrationMinutes: 5,
    burnMultiplier: 1.5,
  },
  balanced: {
    label: 'Balanced',
    reservePercent: 10,
    maxMinutes: 90,
    checkpointMinutes: 10,
    calibrationMinutes: 5,
    burnMultiplier: 1.25,
  },
  harvest: {
    label: 'Harvest',
    reservePercent: 5,
    maxMinutes: 120,
    checkpointMinutes: 10,
    calibrationMinutes: 5,
    burnMultiplier: 1.15,
  },
});

export const PROVIDERS = Object.freeze(['codex']);
export const CODEX_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh']);

export const PROBLEMS = Object.freeze({
  rh: {
    canonical: 'riemann-hypothesis',
    name: 'Riemann Hypothesis',
    routes: {
      prove: { label: 'Prove RH', protocolRoute: 'prove' },
      refute: { label: 'Find an off-line zero', protocolRoute: 'refute-or-search-witness' },
    },
  },
  pnp: {
    canonical: 'p-vs-np',
    name: 'P vs NP',
    routes: {
      equal: { label: 'Establish P = NP', protocolRoute: 'prove' },
      separate: { label: 'Establish P != NP', protocolRoute: 'prove' },
    },
  },
  ns: {
    canonical: 'navier-stokes',
    name: 'Navier-Stokes',
    routes: {
      regular: { label: 'Prove global regularity', protocolRoute: 'prove' },
      blowup: { label: 'Prove finite-time breakdown', protocolRoute: 'refute-or-search-witness' },
    },
  },
  hodge: {
    canonical: 'hodge-conjecture',
    name: 'Hodge Conjecture',
    routes: {
      prove: { label: 'Prove algebraicity', protocolRoute: 'prove' },
      refute: { label: 'Construct a non-algebraic class', protocolRoute: 'refute-or-search-witness' },
    },
  },
  bsd: {
    canonical: 'birch-swinnerton-dyer',
    name: 'Birch-Swinnerton-Dyer',
    routes: {
      prove: { label: 'Prove the rank equality', protocolRoute: 'prove' },
      refute: { label: 'Find a rank mismatch', protocolRoute: 'refute-or-search-witness' },
    },
  },
  ym: {
    canonical: 'yang-mills-mass-gap',
    name: 'Yang-Mills & Mass Gap',
    routes: {
      construct: { label: 'Construct and prove a gap', protocolRoute: 'prove' },
      obstruct: { label: 'Find a rigorous obstruction', protocolRoute: 'falsify-intermediate' },
    },
  },
  pc: {
    canonical: 'poincare-conjecture',
    name: 'Poincare Conjecture',
    routes: {
      reconstruct: { label: 'Reconstruct the proof', protocolRoute: 'reproduce' },
      challenge: { label: 'Stress-test the proof', protocolRoute: 'falsify-intermediate' },
    },
  },
});
