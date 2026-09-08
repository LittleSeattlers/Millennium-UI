const PUBLIC_DISPOSITIONS = new Set([
  'completed',
  'time-limit',
  'user-stopped',
  'provider-failed',
  'provider-interrupted',
  'runner-stopped',
]);

/**
 * Reduce an internal stop signal to a small, non-sensitive terminal category.
 * Raw quota messages and provider errors must never cross the hosted API.
 */
export function classifyTerminalDisposition({ status, stopReason = null } = {}) {
  const finalStatus = String(status ?? '').trim().toLowerCase();
  const reason = String(stopReason ?? '').trim().toLowerCase();

  if (finalStatus === 'completed') return 'completed';
  if (reason === 'user' || reason === 'checkpoint-and-stop') return 'user-stopped';
  if (reason.includes('local runner shutting down')) return 'runner-stopped';
  if (finalStatus === 'failed' || finalStatus === 'aborted' || /\b(failed|failure|error)\b/.test(reason)) {
    return 'provider-failed';
  }
  if (/\b(safe time|time budget|budget exhausted|quota|allowance|(?:5-hour|weekly) window)\b/.test(reason)) {
    return 'time-limit';
  }
  if (finalStatus === 'interrupted') return 'provider-interrupted';
  return 'provider-failed';
}

/** Return only a known terminal category for the public loopback API. */
export function publicTerminalDisposition(status, disposition, { elapsedSeconds = 0, allowedMinutes = 0 } = {}) {
  const candidate = String(disposition ?? '').trim().toLowerCase();
  if (PUBLIC_DISPOSITIONS.has(candidate)) return candidate;
  if (candidate === 'runner-interrupted') return 'runner-stopped';
  const inferred = classifyTerminalDisposition({ status });
  const elapsed = Number(elapsedSeconds);
  const allowance = Number(allowedMinutes);
  if (
    inferred === 'provider-interrupted'
    && Number.isFinite(elapsed)
    && Number.isFinite(allowance)
    && allowance > 0
    && elapsed >= Math.max(1, allowance * 60 - 15)
  ) return 'time-limit';
  return inferred;
}

/**
 * Report whether the submitted PR used Codex's validated structured proposal
 * or the runner-owned privacy-safe recovery record. This exposes no prose.
 */
export function publicContributionSource(publication) {
  if (!publication || publication.status !== 'submitted') return null;
  if (publication.usedStructuredProposal === true) return 'structured-proposal';
  if (publication.usedStructuredProposal === false) return 'privacy-safe-fallback';

  // Backward compatibility: before the boolean was persisted, every fallback
  // carried a warning and a clean structured proposal did not.
  return publication.warning
    ? 'privacy-safe-fallback'
    : 'structured-proposal';
}
