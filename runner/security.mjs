import crypto from 'node:crypto';
import path from 'node:path';
import {
  DEFAULT_ALLOWED_ORIGINS,
  MAX_JSON_BODY_BYTES,
  MAX_PUBLIC_TEXT,
  PUBLIC_UI_ORIGIN,
  RUNNER_PORT,
} from './constants.mjs';

export class HttpError extends Error {
  constructor(status, message, code = 'request_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function getAllowedOrigins() {
  const configured = process.env.MILLENNIUM_ALLOWED_ORIGINS;
  if (!configured) return new Set(DEFAULT_ALLOWED_ORIGINS);
  const origins = configured.split(',').map((value) => value.trim()).filter(Boolean);
  const isLoopback = (origin) => /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/.test(origin);
  if (origins.some((origin) => origin === '*' || (!isLoopback(origin) && origin !== PUBLIC_UI_ORIGIN))) {
    throw new Error(`MILLENNIUM_ALLOWED_ORIGINS may contain exact loopback HTTP origins and ${PUBLIC_UI_ORIGIN} only.`);
  }
  return new Set(origins);
}

export function assertLoopbackRequest(req, allowedOrigins) {
  const host = req.headers.host ?? '';
  if (!allowedRunnerHosts().has(host)) throw new HttpError(403, 'Unexpected Host header.', 'host_rejected');

  const origin = req.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) {
    throw new HttpError(403, 'This page is not allowed to control the local runner.', 'origin_rejected');
  }
  return origin;
}

export function assertNativeLoopbackRequest(req) {
  const host = req.headers.host ?? '';
  if (!allowedRunnerHosts().has(host)) throw new HttpError(403, 'Unexpected Host header.', 'host_rejected');
  const remoteAddress = req.socket?.remoteAddress ?? '';
  if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
    throw new HttpError(403, 'Native connector requests must originate on this computer.', 'loopback_rejected');
  }
  if (req.headers.origin) {
    throw new HttpError(403, 'Browser origins cannot use the native connector endpoint.', 'origin_rejected');
  }
}

export function assertLocalConsentRequest(req, { requireOrigin = false } = {}) {
  const host = req.headers.host ?? '';
  if (!allowedRunnerHosts().has(host)) throw new HttpError(403, 'Unexpected Host header.', 'host_rejected');
  const remoteAddress = req.socket?.remoteAddress ?? '';
  if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
    throw new HttpError(403, 'Connector approval must originate on this computer.', 'loopback_rejected');
  }
  const origin = req.headers.origin;
  if (requireOrigin && !allowedRunnerOrigins().has(origin ?? '')) {
    throw new HttpError(403, 'Connector approval must be submitted by the local approval page.', 'origin_rejected');
  }
  if (origin && origin !== 'null' && !allowedRunnerOrigins().has(origin)) {
    throw new HttpError(403, 'Unexpected connector approval origin.', 'origin_rejected');
  }
}

function allowedRunnerHosts() {
  return new Set([
    `127.0.0.1:${RUNNER_PORT}`,
    `localhost:${RUNNER_PORT}`,
  ]);
}

function allowedRunnerOrigins() {
  return new Set([
    `http://127.0.0.1:${RUNNER_PORT}`,
    `http://localhost:${RUNNER_PORT}`,
  ]);
}

export function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Last-Event-ID',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  };
}

export function tokensEqual(actual, expected) {
  const left = Buffer.from(actual ?? '', 'utf8');
  const right = Buffer.from(expected ?? '', 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

export function readBearerToken(req) {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(header);
  if (!match) {
    throw new HttpError(401, 'The local runner token is missing or invalid.', 'unauthorized');
  }
  return match[1];
}

export function assertBearerToken(req, expectedToken) {
  const actualToken = readBearerToken(req);
  if (!tokensEqual(actualToken, expectedToken)) {
    throw new HttpError(401, 'The local runner token is missing or invalid.', 'unauthorized');
  }
  return actualToken;
}

export async function readJsonBody(req) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json.', 'content_type');

  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_JSON_BODY_BYTES) throw new HttpError(413, 'Request body is too large.', 'body_too_large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.', 'invalid_json');
  }
}

export function requireString(value, name, { min = 1, max = 2000 } = {}) {
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be text.`, 'validation');
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new HttpError(400, `${name} must contain ${min}-${max} characters.`, 'validation');
  }
  return normalized;
}

export function requireChoice(value, choices, name) {
  if (!choices.includes(value)) throw new HttpError(400, `${name} is not supported.`, 'validation');
  return value;
}

export function requireNumber(value, name, { min = 0, max = 100 } = {}) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new HttpError(400, `${name} must be between ${min} and ${max}.`, 'validation');
  }
  return number;
}

export function assertIdentifier(value, name = 'identifier') {
  const normalized = requireString(value, name, { min: 3, max: 180 });
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    throw new HttpError(400, `${name} contains invalid characters.`, 'validation');
  }
  return normalized;
}

export function resolveWithin(root, ...segments) {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...segments);
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new HttpError(400, 'Resolved path left the allowed root.', 'path_traversal');
  }
  return candidate;
}

const REDACTIONS = [
  [/\b(?:sk|sess|key)-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_TOKEN]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*\b/gi, 'Bearer [REDACTED]'],
  [/\b(OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)\s*[=:]\s*\S+/gi, '$1=[REDACTED]'],
  [/[A-Za-z]:\\Users\\[^\\\s]+/gi, '%USERPROFILE%'],
  [/\/(?:Users|home)\/[^/\s]+/g, '$HOME'],
];

export function sanitizePublicText(value, replacements = []) {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const [from, to] of replacements) text = text.split(from).join(to);
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  return text.length > MAX_PUBLIC_TEXT ? `${text.slice(0, MAX_PUBLIC_TEXT)}\n[truncated]` : text;
}

const COMMON_ENV_KEYS = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'HOME', 'HOMEDRIVE', 'HOMEPATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'LANG', 'LC_ALL', 'TERM', 'COLORTERM', 'NO_COLOR',
  'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
];

const BILLING_SELECTORS = Object.freeze({
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL'],
  claude: [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  ],
});

export function billingSelectorNames(provider, environment = process.env) {
  return (BILLING_SELECTORS[provider] ?? []).filter((key) => Boolean(environment[key]));
}

export function subscriptionEnvironment(provider, environment = process.env) {
  const result = {};
  for (const key of COMMON_ENV_KEYS) {
    if (environment[key] !== undefined) result[key] = environment[key];
  }
  if (provider === 'claude' && environment.CLAUDE_CODE_OAUTH_TOKEN) {
    result.CLAUDE_CODE_OAUTH_TOKEN = environment.CLAUDE_CODE_OAUTH_TOKEN;
  }
  result.MILLENNIUM_SUBSCRIPTION_ONLY = '1';
  result.NO_COLOR = '1';
  return result;
}
