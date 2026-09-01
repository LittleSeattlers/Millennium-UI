import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttemptManager } from './attempts.mjs';
import {
  CODEX_EFFORTS,
  PROBLEMS,
  PUBLIC_SESSION_TTL_MS,
  PUBLIC_UI_URL,
  RISK_MODES,
  RUNNER_HOST,
  RUNNER_PORT,
  RUNNER_VERSION,
} from './constants.mjs';
import {
  HttpError,
  assertBearerToken,
  assertLoopbackRequest,
  assertLocalConsentRequest,
  assertNativeLoopbackRequest,
  corsHeaders,
  getAllowedOrigins,
  readBearerToken,
  readJsonBody,
  requireChoice,
  requireNumber,
  requireString,
  sanitizePublicText,
  tokensEqual,
} from './security.mjs';
import { RESEARCH_MODES } from './frontier.mjs';
import { publicContributionSource, publicTerminalDisposition } from './terminal.mjs';

const ATTEMPT_PATH = /^\/api\/v1\/attempts\/([a-z0-9][a-z0-9._-]{2,179})$/;
const ATTEMPT_ACTION_PATH = /^\/api\/v1\/attempts\/([a-z0-9][a-z0-9._-]{2,179})\/(events|checkpoint|stop)$/;
const PUBLIC_ATTEMPT_PATH = /^\/api\/v1\/public\/attempts\/([a-z0-9][a-z0-9._-]{2,179})$/;
const PUBLIC_ATTEMPT_ACTION_PATH = /^\/api\/v1\/public\/attempts\/([a-z0-9][a-z0-9._-]{2,179})\/(events|checkpoint|stop|publish)$/;
const PUBLIC_PAIR_PATH = '/api/v1/public/pair';
const PUBLIC_API_PREFIX = '/api/v1/public/';
const NATIVE_TICKET_PATH = '/api/v1/native/tickets';
const NATIVE_STATUS_PATH = '/api/v1/native/status';
const CONNECTOR_CONSENT_PATH = '/connect/v1';
const CONNECTOR_CONSENT_DECISION_PATH = '/connect/v1/decision';
const PUBLIC_SESSION_LIMIT = 8;
const PUBLIC_TICKET_LIMIT = 8;
const PUBLIC_TICKET_TTL_MS = 60_000;
const PUBLIC_CONSENT_TTL_MS = 2 * 60_000;
const PUBLIC_START_REQUEST_LIMIT = 32;
const PUBLIC_START_REQUEST_TTL_MS = 10 * 60_000;
const KEEP_PERCENT = Object.freeze({ protect: 15, balanced: 10, harvest: 5 });
const TERMINAL_ATTEMPT_STATUSES = new Set(['completed', 'interrupted', 'aborted', 'failed']);

export async function startRunner({
  token = process.env.MILLENNIUM_RUNNER_TOKEN,
  pairingCode = process.env.MILLENNIUM_PAIRING_CODE,
  nativeControlToken = process.env.MILLENNIUM_NATIVE_CONTROL_TOKEN,
} = {}) {
  const runnerToken = token || crypto.randomBytes(32).toString('base64url');
  if (!/^[A-Za-z0-9_-]{32,}$/.test(runnerToken)) {
    throw new Error('MILLENNIUM_RUNNER_TOKEN must be at least 32 URL-safe characters.');
  }
  if (nativeControlToken && !/^[A-Za-z0-9_-]{32,}$/.test(nativeControlToken)) {
    throw new Error('MILLENNIUM_NATIVE_CONTROL_TOKEN must be at least 32 URL-safe characters.');
  }
  const publicControl = createPublicControl(pairingCode);

  const manager = new AttemptManager();
  await manager.init();
  const allowedOrigins = getAllowedOrigins();
  const server = http.createServer((req, res) => {
    void routeRequest({ req, res, manager, allowedOrigins, runnerToken, publicControl, nativeControlToken });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 16;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(RUNNER_PORT, RUNNER_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const close = async () => {
    const activeId = manager.health().activeAttemptId;
    if (activeId) {
      try { await manager.stop(activeId, 'local runner shutting down'); } catch { /* close anyway */ }
    }
    publicControl.sessions.clear();
    await new Promise((resolve) => server.close(resolve));
  };
  return { server, manager, token: runnerToken, pairingEnabled: Boolean(publicControl.pairingCode), close };
}

async function routeRequest({ req, res, manager, allowedOrigins, runnerToken, publicControl, nativeControlToken }) {
  const pathname = requestPathname(req);
  if (pathname === CONNECTOR_CONSENT_PATH || pathname === CONNECTOR_CONSENT_DECISION_PATH) {
    await routeConnectorConsent({ req, res, publicControl, pathname });
    return;
  }
  if (pathname === NATIVE_TICKET_PATH || pathname === NATIVE_STATUS_PATH) {
    await routeNativeControl({ req, res, manager, publicControl, nativeControlToken, pathname });
    return;
  }
  let origin;
  try {
    origin = assertLoopbackRequest(req, allowedOrigins);
  } catch (error) {
    sendError(res, error, null);
    return;
  }
  const headers = corsHeaders(origin);

  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (req.method === 'OPTIONS') {
      assertPreflight(req);
      res.writeHead(204, securityHeaders(headers));
      res.end();
      return;
    }
    if (req.method === 'POST' && pathname === PUBLIC_PAIR_PATH) {
      await pairPublicSession({ req, res, origin, headers, manager, publicControl });
      return;
    }
    if (pathname.startsWith(PUBLIC_API_PREFIX)) {
      const session = assertPublicSession(req, origin, publicControl);
      await routePublicRequest({ req, res, manager, url, pathname, headers, session, publicControl });
      return;
    }
    assertBearerToken(req, runnerToken);

    if (req.method === 'GET' && pathname === '/api/v1/health') {
      sendJson(res, 200, manager.health(), headers);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/v1/providers') {
      sendJson(res, 200, await manager.providerState(), headers);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/v1/providers/refresh') {
      const body = await readJsonBody(req);
      sendJson(res, 200, await manager.refreshProviders(body.provider ?? null), headers);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/v1/quota/snapshots') {
      const body = await readJsonBody(req);
      const snapshot = await manager.saveManualSnapshot(body);
      const quota = await manager.estimate({
        provider: snapshot.provider,
        riskMode: body.riskMode ?? 'balanced',
        keepPercent: body.keepPercent ?? 10,
      });
      sendJson(res, 201, { snapshot, estimate: quota.estimate }, headers);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/v1/quota/estimate') {
      sendJson(res, 200, await manager.estimate(await readJsonBody(req)), headers);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/v1/attempts') {
      sendJson(res, 200, await manager.list(), headers);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/v1/attempts') {
      sendJson(res, 201, { attempt: await manager.start(await readJsonBody(req)) }, headers);
      return;
    }

    const attemptMatch = ATTEMPT_PATH.exec(pathname);
    if (req.method === 'GET' && attemptMatch) {
      sendJson(res, 200, { attempt: await manager.get(attemptMatch[1]) }, headers);
      return;
    }

    const actionMatch = ATTEMPT_ACTION_PATH.exec(pathname);
    if (actionMatch) {
      const [, id, action] = actionMatch;
      if (req.method === 'GET' && action === 'events') {
        await streamEvents({ req, res, manager, id, url, headers });
        return;
      }
      if (req.method === 'POST' && action === 'checkpoint') {
        const body = await readJsonBody(req);
        sendJson(res, 200, await manager.checkpoint(id, { stop: body.stop === true }), headers);
        return;
      }
      if (req.method === 'POST' && action === 'stop') {
        const body = await readJsonBody(req);
        const reason = body.reason === undefined
          ? 'user'
          : requireString(body.reason, 'reason', { min: 2, max: 160 });
        sendJson(res, 200, { attempt: await manager.stop(id, reason) }, headers);
        return;
      }
    }

    throw new HttpError(404, 'Local runner endpoint not found.', 'not_found');
  } catch (error) {
    sendError(res, error, headers);
  }
}

async function routeConnectorConsent({ req, res, publicControl, pathname }) {
  try {
    if (req.method === 'GET' && pathname === CONNECTOR_CONSENT_PATH) {
      assertLocalConsentRequest(req);
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const input = requirePublicTicketInput({
        requestId: url.searchParams.get('request_id'),
        challenge: url.searchParams.get('challenge'),
      });
      const returnTo = requireConnectorReturnUrl(url.searchParams.get('return_to'));
      const consent = createConnectorConsent(publicControl, { ...input, returnTo });
      sendConnectorConsentPage(res, consent);
      return;
    }
    if (req.method === 'POST' && pathname === CONNECTOR_CONSENT_DECISION_PATH) {
      assertLocalConsentRequest(req);
      const form = await readFormBody(req);
      const decision = requireString(form.get('decision'), 'decision', { min: 4, max: 5 });
      if (!['allow', 'deny'].includes(decision)) {
        throw new HttpError(400, 'The connector approval is malformed.', 'validation');
      }
      const consent = readConnectorConsent(publicControl, form.get('consent'));
      if (decision === 'allow') registerPublicTicket(publicControl, consent);
      const location = connectorDecisionUrl(consent.returnTo, decision);
      if (acceptsJson(req)) {
        sendJson(res, 200, { location });
      } else {
        sendConnectorDecisionRedirect(res, location);
      }
      return;
    }
    throw new HttpError(404, 'Connector approval page not found.', 'not_found');
  } catch (error) {
    const message = error instanceof HttpError && error.status < 500
      ? error.message
      : 'The local connector could not prepare this approval.';
    if (!(error instanceof HttpError) || error.status >= 500) console.error(error);
    if (acceptsJson(req)) {
      sendError(res, error, {});
    } else {
      sendConnectorMessagePage(res, 'Connection unavailable', message);
    }
  }
}

async function routeNativeControl({ req, res, manager, publicControl, nativeControlToken, pathname }) {
  try {
    assertNativeLoopbackRequest(req);
    if (!nativeControlToken) {
      throw new HttpError(404, 'Native connector control is not enabled.', 'not_found');
    }
    assertBearerToken(req, nativeControlToken);
    if (req.method === 'GET' && pathname === NATIVE_STATUS_PATH) {
      sendJson(res, 200, {
        ok: true,
        pid: process.pid,
        version: RUNNER_VERSION,
        runnerBusy: Boolean(manager.health().activeAttemptId),
      }, {});
      return;
    }
    if (req.method === 'POST' && pathname === NATIVE_TICKET_PATH) {
      const body = await readJsonBody(req);
      const ticket = registerPublicTicket(publicControl, body);
      sendJson(res, 200, {
        armed: true,
        expiresAt: new Date(ticket.expiresAtMs).toISOString(),
        runnerBusy: Boolean(manager.health().activeAttemptId),
      }, {});
      return;
    }
    throw new HttpError(404, 'Native connector endpoint not found.', 'not_found');
  } catch (error) {
    sendError(res, error, null);
  }
}

function registerPublicTicket(publicControl, body, now = Date.now()) {
  const { requestId, challenge } = requirePublicTicketInput(body);
  purgePublicTickets(publicControl, now);
  const existing = publicControl.tickets.get(requestId);
  if (existing) {
    if (!tokensEqual(existing.challenge, challenge)) {
      throw new HttpError(409, 'The launch ticket identifier is already in use.', 'ticket_conflict');
    }
    return existing;
  }
  if (publicControl.tickets.size >= PUBLIC_TICKET_LIMIT) {
    throw new HttpError(429, 'Too many connector launches are pending. Wait a minute and try again.', 'ticket_capacity');
  }
  const ticket = {
    challenge,
    expiresAtMs: now + PUBLIC_TICKET_TTL_MS,
    sessionToken: null,
  };
  publicControl.tickets.set(requestId, ticket);
  return ticket;
}

function requirePublicTicketInput(body) {
  const requestId = requireString(body?.requestId, 'requestId', { min: 22, max: 22 });
  const challenge = requireString(body?.challenge, 'challenge', { min: 43, max: 43 });
  if (!/^[A-Za-z0-9_-]{22}$/.test(requestId) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    throw new HttpError(400, 'The launch ticket is malformed.', 'validation');
  }
  return { requestId, challenge };
}

export function createConnectorConsent(publicControl, input, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    requestId: input.requestId,
    challenge: input.challenge,
    returnTo: input.returnTo,
    issuedAtMs: now,
    expiresAtMs: now + PUBLIC_CONSENT_TTL_MS,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', publicControl.consentKey)
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

export function readConnectorConsent(publicControl, value, now = Date.now()) {
  const token = requireString(value, 'consent', { min: 100, max: 512 });
  const parts = token.split('.');
  if (
    parts.length !== 2
    || !/^[A-Za-z0-9_-]+$/.test(parts[0])
    || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])
  ) {
    throw new HttpError(400, 'The connector approval is malformed.', 'validation');
  }
  const expected = crypto.createHmac('sha256', publicControl.consentKey)
    .update(parts[0])
    .digest('base64url');
  if (!tokensEqual(parts[1], expected)) {
    throw new HttpError(400, 'The connector approval is malformed.', 'validation');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(400, 'The connector approval is malformed.', 'validation');
  }
  if (
    payload?.version !== 1
    || !Number.isSafeInteger(payload.issuedAtMs)
    || !Number.isSafeInteger(payload.expiresAtMs)
    || payload.expiresAtMs - payload.issuedAtMs !== PUBLIC_CONSENT_TTL_MS
  ) {
    throw new HttpError(400, 'The connector approval is malformed.', 'validation');
  }
  if (payload.expiresAtMs <= now) {
    throw new HttpError(410, 'This connector approval expired. Return to Millennium and try again.', 'consent_expired');
  }
  return {
    ...requirePublicTicketInput(payload),
    returnTo: requireConnectorReturnUrl(payload.returnTo),
    expiresAtMs: payload.expiresAtMs,
  };
}

function requireConnectorReturnUrl(value) {
  let url;
  try {
    url = new URL(requireString(value, 'return_to', { min: 12, max: 300 }));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'The connector return address is invalid.', 'validation');
  }
  url.search = '';
  url.hash = '';
  const allowed = new Set([
    PUBLIC_UI_URL,
    'http://localhost:3001/Millennium-UI/',
    'http://127.0.0.1:3001/Millennium-UI/',
  ]);
  if (!allowed.has(url.toString())) {
    throw new HttpError(400, 'The connector return address is not allowed.', 'validation');
  }
  return url.toString();
}

function requestPathname(req) {
  try {
    return new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    return '';
  }
}

function createPublicControl(pairingCode) {
  const normalized = normalizePairingCode(pairingCode ?? '');
  if (normalized && !/^[A-Z0-9]{16,64}$/.test(normalized)) {
    throw new Error('MILLENNIUM_PAIRING_CODE must contain 16-64 letters or digits.');
  }
  return {
    pairingCode: normalized || null,
    consentKey: crypto.randomBytes(32),
    sessions: new Map(),
    tickets: new Map(),
    attemptOwners: new Map(),
    startRequests: new Map(),
  };
}

function normalizePairingCode(value) {
  return String(value ?? '').replace(/[\s-]/g, '').toUpperCase();
}

async function pairPublicSession({ req, res, origin, headers, manager, publicControl }) {
  const now = Date.now();
  const body = await readJsonBody(req);
  purgePublicSessions(publicControl, now);
  purgePublicTickets(publicControl, now);

  if (body?.requestId !== undefined || body?.verifier !== undefined) {
    const requestId = requireString(body?.requestId, 'requestId', { min: 22, max: 22 });
    const verifier = requireString(body?.verifier, 'verifier', { min: 43, max: 43 });
    if (!/^[A-Za-z0-9_-]{22}$/.test(requestId) || !/^[A-Za-z0-9_-]{43}$/.test(verifier)) {
      throw new HttpError(400, 'The launch ticket is malformed.', 'validation');
    }
    const ticket = publicControl.tickets.get(requestId);
    if (!ticket || ticket.expiresAtMs <= now || !tokensEqual(hashVerifier(verifier), ticket.challenge)) {
      throw new HttpError(401, 'The launch ticket is missing, expired, or invalid.', 'pairing_rejected');
    }
    if (ticket.sessionToken) {
      const existing = publicControl.sessions.get(ticket.sessionToken);
      if (!existing) throw new HttpError(409, 'The launch ticket was already consumed.', 'pairing_consumed');
      sendPublicSession(res, existing, manager, headers);
      return;
    }
    const session = createPublicSession(
      publicControl,
      origin,
      now,
      protectedPublicSessionIds(manager, publicControl),
    );
    ticket.sessionToken = session.id;
    sendPublicSession(res, session, manager, headers, 201);
    return;
  }

  if (!publicControl.pairingCode) {
    throw new HttpError(404, 'Hosted pairing is not enabled for this runner.', 'pairing_disabled');
  }
  const supplied = normalizePairingCode(requireString(body?.code, 'pairing code', { min: 16, max: 80 }));
  if (!tokensEqual(supplied, publicControl.pairingCode)) {
    throw new HttpError(401, 'The pairing code is incorrect.', 'pairing_rejected');
  }
  publicControl.pairingCode = null;
  const session = createPublicSession(
    publicControl,
    origin,
    now,
    protectedPublicSessionIds(manager, publicControl),
  );
  sendPublicSession(res, session, manager, headers, 201);
}

export function createPublicSession(
  publicControl,
  origin,
  now = Date.now(),
  protectedSessionIds = new Set(),
) {
  if (publicControl.sessions.size >= PUBLIC_SESSION_LIMIT) {
    evictOldestPublicSession(publicControl, protectedSessionIds);
  }
  if (publicControl.sessions.size >= PUBLIC_SESSION_LIMIT) {
    throw new HttpError(
      429,
      'All hosted control sessions are protecting active work. Stop that work or disconnect its tab, then try again.',
      'session_capacity',
    );
  }
  const sessionToken = crypto.randomBytes(32).toString('base64url');
  const expiresAtMs = now + PUBLIC_SESSION_TTL_MS;
  const session = {
    id: sessionToken,
    origin,
    expiresAtMs,
    lastSeenAtMs: now,
    attemptIds: new Set(),
  };
  publicControl.sessions.set(sessionToken, session);
  return session;
}

function protectedPublicSessionIds(manager, publicControl) {
  const protectedIds = new Set();
  const activeAttemptId = manager.health().activeAttemptId;
  const activeSessionId = activeAttemptId
    ? publicControl.attemptOwners.get(activeAttemptId)
    : null;
  if (activeSessionId) protectedIds.add(activeSessionId);
  for (const startRequest of publicControl.startRequests.values()) {
    if (startRequest.status === 'starting') protectedIds.add(startRequest.sessionId);
  }
  return protectedIds;
}

function evictOldestPublicSession(publicControl, protectedSessionIds) {
  let oldest = null;
  for (const [token, session] of publicControl.sessions) {
    if (protectedSessionIds.has(token)) continue;
    const lastSeenAtMs = Number.isFinite(session.lastSeenAtMs) ? session.lastSeenAtMs : 0;
    if (!oldest || lastSeenAtMs < oldest.lastSeenAtMs) oldest = { token, lastSeenAtMs };
  }
  if (oldest) deletePublicSession(publicControl, oldest.token);
}

function sendPublicSession(res, session, manager, headers, status = 200) {
  sendJson(res, status, {
    sessionToken: session.id,
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    health: publicHealth(manager.health(), null),
  }, headers);
}

function purgePublicSessions(publicControl, now = Date.now()) {
  for (const [token, session] of publicControl.sessions) {
    if (session.expiresAtMs > now) continue;
    deletePublicSession(publicControl, token);
  }
}

function deletePublicSession(publicControl, token) {
  publicControl.sessions.delete(token);
  for (const [attemptId, owner] of publicControl.attemptOwners) {
    if (owner === token) publicControl.attemptOwners.delete(attemptId);
  }
  for (const [key, startRequest] of publicControl.startRequests) {
    if (startRequest.sessionId === token) publicControl.startRequests.delete(key);
  }
}

function purgePublicTickets(publicControl, now = Date.now()) {
  for (const [requestId, ticket] of publicControl.tickets) {
    if (ticket.expiresAtMs <= now) publicControl.tickets.delete(requestId);
  }
}

function purgePublicStartRequests(publicControl, now = Date.now()) {
  for (const [key, startRequest] of publicControl.startRequests) {
    if (startRequest.expiresAtMs <= now) publicControl.startRequests.delete(key);
  }
}

function assertPublicSession(req, origin, publicControl) {
  purgePublicSessions(publicControl);
  const actual = readBearerToken(req);
  for (const [expected, session] of publicControl.sessions) {
    if (!tokensEqual(actual, expected)) continue;
    if (session.origin !== origin) break;
    session.lastSeenAtMs = Date.now();
    return session;
  }
  throw new HttpError(401, 'The hosted control session is missing, expired, or invalid.', 'unauthorized');
}

async function routePublicRequest({ req, res, manager, url, pathname, headers, session, publicControl }) {
  if (req.method === 'POST' && pathname === '/api/v1/public/session/revoke') {
    await readJsonBody(req);
    const activeId = manager.health().activeAttemptId;
    if (activeId && publicControl.attemptOwners.get(activeId) === session.id) {
      throw new HttpError(409, 'Stop the active attempt before disconnecting this control session.', 'attempt_active');
    }
    deletePublicSession(publicControl, readBearerToken(req));
    sendJson(res, 200, { revoked: true }, headers);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/v1/public/state') {
    const health = manager.health();
    let activeAttempt = null;
    const ownsActiveAttempt = Boolean(
      health.activeAttemptId
      && publicControl.attemptOwners.get(health.activeAttemptId) === session.id
      && session.attemptIds.has(health.activeAttemptId),
    );
    if (health.activeAttemptId && ownsActiveAttempt) {
      activeAttempt = publicAttempt(await manager.get(health.activeAttemptId));
    }
    if (!activeAttempt) {
      const recent = (await manager.list()).attempts.find((attempt) => (
        TERMINAL_ATTEMPT_STATUSES.has(attempt.status)
        && ['claimed', 'failed'].includes(attempt.publication?.status)
      ));
      if (recent) {
        session.attemptIds.add(recent.id);
        activeAttempt = publicAttempt(recent);
      }
    }
    const state = await manager.providerState();
    const codex = state.providers.find((provider) => provider.id === 'codex') ?? null;
    sendJson(res, 200, {
      health: publicHealth(health, ownsActiveAttempt ? health.activeAttemptId : null),
      provider: publicProvider(codex),
      activeAttempt,
    }, headers);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/v1/public/providers/refresh') {
    await readJsonBody(req);
    const state = await manager.refreshProviders('codex');
    const codex = state.providers.find((provider) => provider.id === 'codex') ?? null;
    sendJson(res, 200, { provider: publicProvider(codex) }, headers);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/v1/public/quota/estimate') {
    const body = await readJsonBody(req);
    const riskMode = body?.riskMode ?? 'balanced';
    const result = await manager.estimate({
      provider: 'codex',
      riskMode,
      keepPercent: KEEP_PERCENT[riskMode] ?? 10,
    });
    sendJson(res, 200, { estimate: publicEstimate(result.estimate) }, headers);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/v1/public/frontier') {
    const problemId = requireChoice(url.searchParams.get('problemId'), Object.keys(PROBLEMS), 'problemId');
    const direction = requireChoice(
      url.searchParams.get('direction'),
      Object.keys(PROBLEMS[problemId].routes),
      'direction',
    );
    const safeMinutes = Math.floor(requireNumber(
      url.searchParams.get('minutes') ?? 30,
      'minutes',
      { min: 1, max: 120 },
    ));
    let frontier;
    try {
      frontier = await manager.frontier({ problemId, direction, safeMinutes });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        503,
        'The shared GitHub research frontier is temporarily unavailable. Click Refresh Codex to retry.',
        'coordination_unavailable',
      );
    }
    sendJson(res, 200, frontier, headers);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/v1/public/attempts') {
    const body = await readJsonBody(req);
    if (body?.provider !== undefined && body.provider !== 'codex') {
      throw new HttpError(400, 'Hosted control supports Codex only.', 'validation');
    }
    const problemId = requireChoice(body?.problemId, Object.keys(PROBLEMS), 'problemId');
    const direction = requireChoice(body?.direction, Object.keys(PROBLEMS[problemId].routes), 'direction');
    const riskMode = requireChoice(body?.riskMode ?? 'balanced', Object.keys(RISK_MODES), 'riskMode');
    const requestedMinutes = Math.floor(requireNumber(body?.requestedMinutes, 'requestedMinutes', { min: 1, max: 120 }));
    const effort = requireChoice(body?.effort ?? 'high', CODEX_EFFORTS, 'effort');
    const model = requireString(body?.model ?? 'default', 'model', { min: 1, max: 160 });
    const taskMode = requireChoice(body?.taskMode ?? 'explore', RESEARCH_MODES, 'taskMode');
    const taskId = body?.taskId == null
      ? null
      : requireString(body.taskId, 'taskId', { min: 8, max: 180 });
    const newDirection = taskMode === 'explore'
      ? requireString(body?.newDirection ?? body?.objective, 'newDirection', { min: 20, max: 600 })
      : null;
    const preparedResearchTask = await manager.resolveResearchTask({
      problemId,
      direction,
      taskMode,
      taskId,
      newDirection,
      safeMinutes: requestedMinutes,
    });
    const request = {
      provider: 'codex',
      problemId,
      direction,
      riskMode,
      keepPercent: KEEP_PERCENT[riskMode] ?? 10,
      requestedMinutes,
      effort,
      model,
      networkAccess: false,
      objective: preparedResearchTask.objective,
      taskMode,
      taskId: preparedResearchTask.id,
      newDirection,
      taskLeaseOwner: publicSessionLeaseOwner(session.id),
      preparedResearchTask,
    };
    const startRequestId = requireString(body?.startRequestId, 'startRequestId', { min: 22, max: 22 });
    if (!/^[A-Za-z0-9_-]{22}$/.test(startRequestId)) {
      throw new HttpError(400, 'The start request identifier is malformed.', 'validation');
    }
    purgePublicStartRequests(publicControl);
    const startKey = `${session.id}:${startRequestId}`;
    const requestHash = hashPublicStartRequest(request);
    const previousStart = publicControl.startRequests.get(startKey);
    if (previousStart) {
      if (!tokensEqual(previousStart.requestHash, requestHash)) {
        throw new HttpError(409, 'The start request identifier was reused with different settings.', 'start_request_conflict');
      }
      if (previousStart.status === 'started' && previousStart.attemptId) {
        session.attemptIds.add(previousStart.attemptId);
        sendJson(res, 200, { attempt: publicAttempt(await manager.get(previousStart.attemptId)) }, headers);
        return;
      }
      throw new HttpError(409, 'This start request is already pending or did not complete. Review local state before trying again.', 'start_request_pending');
    }
    if (publicControl.startRequests.size >= PUBLIC_START_REQUEST_LIMIT) {
      throw new HttpError(429, 'Too many recent start requests are retained. Wait a few minutes and try again.', 'start_request_capacity');
    }
    const startRecord = {
      sessionId: session.id,
      requestHash,
      status: 'starting',
      attemptId: null,
      expiresAtMs: Date.now() + PUBLIC_START_REQUEST_TTL_MS,
    };
    publicControl.startRequests.set(startKey, startRecord);
    try {
      if (session.expiresAtMs <= Date.now() || publicControl.sessions.get(session.id) !== session) {
        throw new HttpError(401, 'The hosted control session expired before the run started.', 'unauthorized');
      }
      const attempt = await manager.start(request);
      session.attemptIds.add(attempt.id);
      publicControl.attemptOwners.set(attempt.id, session.id);
      startRecord.status = 'started';
      startRecord.attemptId = attempt.id;
      sendJson(res, 201, { attempt: publicAttempt(attempt) }, headers);
      return;
    } catch (error) {
      if (startRecord.status !== 'started') startRecord.status = 'failed';
      throw error;
    }
  }

  const attemptMatch = PUBLIC_ATTEMPT_PATH.exec(pathname);
  if (req.method === 'GET' && attemptMatch) {
    assertPublicAttemptAccess(session, attemptMatch[1]);
    const attempt = await manager.get(attemptMatch[1]);
    releaseTerminalAttempt(publicControl, attempt);
    sendJson(res, 200, { attempt: publicAttempt(attempt) }, headers);
    return;
  }

  const actionMatch = PUBLIC_ATTEMPT_ACTION_PATH.exec(pathname);
  if (actionMatch) {
    const [, id, action] = actionMatch;
    assertPublicAttemptAccess(session, id);
    if (req.method === 'GET' && action === 'events') {
      await streamEvents({ req, res, manager, id, url, headers, transformEvent: publicEvent });
      return;
    }
    if (req.method === 'POST' && action === 'checkpoint') {
      const body = await readJsonBody(req);
      const result = await manager.checkpoint(id, { stop: body.stop === true });
      releaseTerminalAttempt(publicControl, result.attempt);
      sendJson(res, 200, { attempt: publicAttempt(result.attempt) }, headers);
      return;
    }
    if (req.method === 'POST' && action === 'stop') {
      await readJsonBody(req);
      const attempt = await manager.stop(id, 'user');
      releaseTerminalAttempt(publicControl, attempt);
      sendJson(res, 200, { attempt: publicAttempt(attempt) }, headers);
      return;
    }
    if (req.method === 'POST' && action === 'publish') {
      await readJsonBody(req);
      const attempt = await manager.retryPublication(id);
      sendJson(res, 200, { attempt: publicAttempt(attempt) }, headers);
      return;
    }
  }

  throw new HttpError(404, 'Hosted control endpoint not found.', 'not_found');
}

function assertPublicAttemptAccess(session, id) {
  if (!session.attemptIds.has(id)) {
    throw new HttpError(404, 'Attempt was not found in this hosted control session.', 'not_found');
  }
}

function releaseTerminalAttempt(publicControl, attempt) {
  if (attempt && TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
    publicControl.attemptOwners.delete(attempt.id);
  }
}

function hashVerifier(verifier) {
  return crypto.createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

function hashPublicStartRequest(request) {
  return crypto.createHash('sha256').update(JSON.stringify(request), 'utf8').digest('base64url');
}

function publicSessionLeaseOwner(sessionId) {
  return `session-${crypto.createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 32)}`;
}

function publicHealth(health, ownedAttemptId) {
  return {
    ok: health.ok === true,
    version: health.version == null ? RUNNER_VERSION : String(health.version),
    activeAttemptId: ownedAttemptId,
    busy: Boolean(health.activeAttemptId),
    coordination: {
      ready: health.coordination?.ready === true,
      syncedAt: health.coordination?.syncedAt == null ? null : String(health.coordination.syncedAt),
      error: health.coordination?.error == null ? null : sanitizePublicText(String(health.coordination.error)),
    },
  };
}

function publicProvider(provider) {
  if (!provider) return null;
  const models = Array.isArray(provider.models)
    ? provider.models.slice(0, 100).map((model) => ({
      id: String(model.id).slice(0, 160),
      model: String(model.model).slice(0, 160),
      displayName: sanitizePublicText(String(model.displayName ?? model.model)).slice(0, 80),
      description: sanitizePublicText(String(model.description ?? '')).slice(0, 240),
      isDefault: model.isDefault === true,
      defaultReasoningEffort: String(model.defaultReasoningEffort ?? 'medium'),
      supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts.filter((effort) => CODEX_EFFORTS.includes(effort))
        : [],
    }))
    : [];
  return {
    id: 'codex',
    installed: provider.installed === true,
    ready: provider.ready === true,
    version: provider.version == null ? null : String(provider.version),
    authKind: provider.authKind == null ? null : String(provider.authKind),
    reason: provider.reason == null ? null : sanitizePublicText(String(provider.reason)),
    models,
    defaultModel: models.some((model) => model.model === provider.defaultModel)
      ? String(provider.defaultModel)
      : models.find((model) => model.isDefault)?.model ?? models[0]?.model ?? null,
  };
}

function publicEstimate(estimate) {
  return {
    status: estimate.status,
    allowedMinutes: Number(estimate.allowedMinutes ?? 0),
    checkpointMinutes: Number(estimate.checkpointMinutes ?? 0),
    calibration: estimate.calibration === true,
    confidence: estimate.confidence == null ? null : String(estimate.confidence),
    bottleneck: estimate.bottleneck == null ? null : String(estimate.bottleneck),
    reason: sanitizePublicText(String(estimate.reason ?? 'No quota estimate is available.')),
    windows: Array.isArray(estimate.windows)
      ? estimate.windows.map((window) => ({
        id: window.id == null ? undefined : String(window.id),
        label: String(window.label ?? 'Quota window'),
        remainingPercent: publicPercentage(window.remainingPercent),
        resetsAt: window.resetsAt == null ? undefined : String(window.resetsAt),
        allowedMinutes: Number(window.allowedMinutes ?? 0),
      }))
      : [],
  };
}

function publicPercentage(value) {
  const percentage = Number(value);
  if (!Number.isFinite(percentage)) return undefined;
  return Math.min(100, Math.max(0, percentage));
}

function publicAttempt(attempt) {
  const allowedMinutes = Number(attempt.allowedMinutes ?? attempt.requestedMinutes ?? attempt.budget?.requested_minutes ?? 0);
  const directElapsed = Number(attempt.elapsedSeconds);
  const completedMinutes = Number(attempt.budget?.completed_minutes);
  const elapsedSeconds = Number.isFinite(directElapsed)
    ? directElapsed
    : Number.isFinite(completedMinutes) ? completedMinutes * 60 : 0;
  const terminalDisposition = TERMINAL_ATTEMPT_STATUSES.has(attempt.status)
    ? publicTerminalDisposition(attempt.status, attempt.disposition, { elapsedSeconds, allowedMinutes })
    : null;
  const contributionSource = publicContributionSource(attempt.publication);
  return {
    id: String(attempt.id),
    provider: 'codex',
    problem: attempt.problem == null ? undefined : String(attempt.problem),
    problemId: attempt.problemId == null ? undefined : String(attempt.problemId),
    problemName: attempt.problemName == null ? undefined : String(attempt.problemName),
    direction: attempt.direction == null ? undefined : String(attempt.direction),
    route: attempt.route == null ? undefined : String(attempt.route),
    routeLabel: attempt.directionLabel == null ? undefined : String(attempt.directionLabel),
    researchTask: publicResearchTask(attempt.researchTask),
    status: String(attempt.status ?? 'planned'),
    terminalDisposition,
    riskMode: attempt.riskMode == null ? undefined : String(attempt.riskMode),
    model: attempt.model == null ? undefined : String(attempt.model),
    effort: attempt.effort == null ? undefined : String(attempt.effort),
    allowedMinutes: Number.isFinite(allowedMinutes) ? allowedMinutes : 0,
    elapsedSeconds,
    createdAt: attempt.createdAt ?? undefined,
    startedAt: attempt.startedAt ?? attempt.createdAt ?? undefined,
    completedAt: attempt.completedAt ?? attempt.finishedAt ?? undefined,
    publication: attempt.publication ? {
      status: String(attempt.publication.status ?? 'unknown'),
      prUrl: attempt.publication.prUrl == null ? null : String(attempt.publication.prUrl),
      prNumber: Number.isSafeInteger(attempt.publication.prNumber) ? attempt.publication.prNumber : null,
      warning: attempt.publication.warning == null ? null : sanitizePublicText(String(attempt.publication.warning)),
      error: attempt.publication.error == null ? null : sanitizePublicText(String(attempt.publication.error)),
      contributionSource,
    } : null,
  };
}

function publicResearchTask(task) {
  if (!task) return null;
  return {
    taskId: String(task.taskId ?? task.id),
    branchId: String(task.branchId),
    mode: String(task.mode),
    kind: String(task.kind),
    title: sanitizePublicText(String(task.title)),
  };
}

function publicEvent(event) {
  const kind = String(event.kind ?? 'ACTIVITY').toUpperCase();
  const messages = {
    START: 'The bounded Codex attempt started.',
    CONTEXT: 'Prior local context was prepared.',
    TASK: 'Codex advanced the bounded task.',
    PLAN: 'Codex updated its local work plan.',
    TOOL: 'Codex used a local research tool.',
    COMMAND: 'Codex ran a command inside the attempt workspace.',
    FILE: 'Codex updated the local attempt artifact.',
    USAGE: 'Codex reported usage telemetry locally.',
    QUOTA: 'The local quota guard refreshed.',
    CHECKPOINT: 'A durable local checkpoint was saved.',
    GUARD: 'A local safety guard changed the run state.',
    WARNING: 'The local companion recorded a warning.',
    ERROR: 'The local companion recorded an error.',
    FINAL: 'The local attempt reached a terminal state.',
  };
  return {
    seq: event.seq,
    attemptId: event.attemptId,
    at: event.at ?? event.timestamp,
    kind: Object.hasOwn(messages, kind) ? kind : 'ACTIVITY',
    level: event.level === 'error' || event.level === 'warning' ? event.level : 'info',
    message: messages[kind] ?? 'The local attempt advanced.',
    detail: null,
  };
}

async function streamEvents({ req, res, manager, id, url, headers, transformEvent = (event) => event }) {
  await manager.get(id);
  const queryAfter = url.searchParams.get('after');
  const headerAfter = req.headers['last-event-id'];
  const after = parseSequence(queryAfter ?? headerAfter ?? '0');
  const buffered = [];
  let replaying = true;
  let lastSent = after;
  const writeEvent = (event) => {
    if (!event || event.seq <= lastSent || res.destroyed) return;
    lastSent = event.seq;
    res.write(`id: ${event.seq}\nevent: activity\ndata: ${JSON.stringify(transformEvent(event))}\n\n`);
  };
  const unsubscribe = manager.subscribe(id, (event) => {
    if (replaying) buffered.push(event);
    else writeEvent(event);
  });

  const replay = await manager.events(id, after);
  res.writeHead(200, securityHeaders({
    ...headers,
    'Content-Type': 'text/event-stream; charset=utf-8',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  }));
  for (const event of [...replay, ...buffered].sort((left, right) => left.seq - right.seq)) writeEvent(event);
  replaying = false;
  res.write(': connected\n\n');
  const heartbeat = setInterval(() => {
    if (!res.destroyed) res.write(': heartbeat\n\n');
  }, 15_000);
  heartbeat.unref?.();
  req.once('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function parseSequence(value) {
  if (!/^\d{1,16}$/.test(String(value))) throw new HttpError(400, 'Event sequence is invalid.', 'validation');
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new HttpError(400, 'Event sequence is invalid.', 'validation');
  return number;
}

function assertPreflight(req) {
  const method = String(req.headers['access-control-request-method'] ?? '').toUpperCase();
  if (method && !['GET', 'POST'].includes(method)) {
    throw new HttpError(403, 'Preflight method rejected.', 'cors_rejected');
  }
  const requested = String(req.headers['access-control-request-headers'] ?? '')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  const allowed = new Set(['authorization', 'content-type', 'last-event-id']);
  if (requested.some((header) => !allowed.has(header))) {
    throw new HttpError(403, 'Preflight headers rejected.', 'cors_rejected');
  }
}

async function readFormBody(req) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') {
    throw new HttpError(415, 'Connector approval must use a form submission.', 'content_type');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 2048) throw new HttpError(413, 'Connector approval is too large.', 'body_too_large');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function sendConnectorConsentPage(res, consent) {
  const nonce = crypto.randomBytes(18).toString('base64url');
  sendConnectorHtml(res, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Millennium</title><style nonce="${nonce}">${connectorPageStyles()}</style></head>
<body><main><div class="mark">M</div><p class="eyebrow">MILLENNIUM CONNECTOR</p>
<h1>Allow this tab to connect?</h1>
<p>This grants one browser tab access to local Codex readiness and quota estimates. Research begins only after you separately click <strong>Start work</strong>.</p>
<form method="post" action="/connect/v1/decision">
<input type="hidden" name="consent" value="${escapeHtml(consent)}">
<button class="allow" type="submit" name="decision" value="allow">Allow connection</button>
<button class="deny" type="submit" name="decision" value="deny">Cancel</button>
</form><p class="status" role="status" aria-live="polite"></p>
<small>This approval expires in two minutes. No account credentials are sent to the website.</small>
</main><script nonce="${nonce}">${connectorConsentScript()}</script></body></html>`, nonce);
}

export function connectorDecisionUrl(returnTo, decision) {
  const url = new URL(returnTo);
  url.searchParams.set('connector', decision === 'allow' ? 'approved' : 'denied');
  url.hash = 'local-codex';
  return url.toString();
}

function sendConnectorDecisionRedirect(res, location) {
  res.writeHead(303, {
    'Cache-Control': 'no-store',
    'Cross-Origin-Opener-Policy': 'same-origin',
    Location: location,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end();
}

function sendConnectorMessagePage(res, title, message) {
  const nonce = crypto.randomBytes(18).toString('base64url');
  sendConnectorHtml(res, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style nonce="${nonce}">${connectorPageStyles()}</style></head>
<body><main><div class="mark">!</div><p class="eyebrow">MILLENNIUM CONNECTOR</p>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><small>Return to Millennium and try again.</small></main></body></html>`, nonce);
}

function sendConnectorHtml(res, html, nonce) {
  res.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(html),
    'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    'Content-Type': 'text/html; charset=utf-8',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-site',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  res.end(html);
}

function connectorPageStyles() {
  return `:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f0e8;color:#172d43;font:15px/1.55 Georgia,serif}main{width:min(92vw,460px);padding:42px;border:1px solid #d6cdbf;border-radius:18px;background:#fffdf8;box-shadow:0 18px 55px #172d4318}.mark{display:grid;place-items:center;width:46px;height:46px;border-radius:50%;background:#17334e;color:#fff;font:700 20px/1 Arial,sans-serif}.eyebrow{margin:22px 0 8px;color:#8a6f46;font:700 10px/1 Arial,sans-serif;letter-spacing:.16em}h1{margin:0 0 12px;font-size:30px;line-height:1.12}p{margin:0;color:#52616b}form{display:grid;grid-template-columns:1fr auto;gap:10px;margin:28px 0 8px}button{padding:12px 16px;border-radius:8px;font:700 12px Arial,sans-serif;cursor:pointer}.allow{border:1px solid #17334e;background:#17334e;color:#fff}.deny{border:1px solid #cfc7bb;background:#fff;color:#59646c}button:disabled{cursor:wait;opacity:.65}.status{min-height:24px;margin:0 0 10px;color:#52616b;font:12px/1.45 Arial,sans-serif}.status.error{color:#9b302b}small{display:block;color:#7d837f;font:11px/1.45 Arial,sans-serif}@media(max-width:420px){main{padding:30px 24px}form{grid-template-columns:1fr}}`;
}

function connectorConsentScript() {
  return `(()=>{const form=document.querySelector('form');const status=document.querySelector('.status');const buttons=[...form.querySelectorAll('button')];form.addEventListener('submit',async(event)=>{const submitter=event.submitter;if(!submitter)return;event.preventDefault();buttons.forEach((button)=>{button.disabled=true});status.classList.remove('error');status.textContent=submitter.value==='allow'?'Connecting this tab…':'Returning to Millennium…';const body=new URLSearchParams(new FormData(form));body.set('decision',submitter.value);try{const response=await fetch(form.action,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:body.toString(),cache:'no-store',credentials:'omit'});const payload=await response.json();if(!response.ok||typeof payload.location!=='string')throw new Error(payload?.error?.message||'The connector did not return a destination.');window.location.replace(payload.location)}catch(error){buttons.forEach((button)=>{button.disabled=false});status.classList.add('error');status.textContent=error instanceof Error?error.message:'Connection could not be completed. Please try again.'}})})();`;
}

function acceptsJson(req) {
  return String(req.headers.accept ?? '').split(',').some((value) => value.trim().split(';')[0] === 'application/json');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function securityHeaders(headers = {}) {
  return {
    ...headers,
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'same-site',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, securityHeaders({
    ...headers,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  }));
  res.end(data);
}

function sendError(res, error, headers) {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  const status = error instanceof HttpError ? error.status : 500;
  const message = status === 500 ? 'The local runner encountered an internal error.' : error.message;
  if (status === 500) console.error(error);
  sendJson(res, status, {
    error: {
      code: error instanceof HttpError ? error.code : 'internal_error',
      message,
    },
  }, headers ?? {});
}

const directPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (directPath === fileURLToPath(import.meta.url)) {
  const runner = await startRunner();
  console.log(`Millennium runner ${RUNNER_VERSION} listening on http://${RUNNER_HOST}:${RUNNER_PORT}`);
  console.log(`Local UI token: ${runner.token}`);
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void runner.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
