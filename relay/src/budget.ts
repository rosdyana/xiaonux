// Per-session budget logic for the relay. Pure and dependency-free (and only
// erasable TypeScript syntax) so Node can import it for unit tests.
// Copyright (c) 2026 xiaonux authors. SPDX-License-Identifier: Apache-2.0

/** bytes a session may move in both directions, across all its WebSockets */
export const SESSION_MAX_BYTES = 512 * 2 ** 20;
/**
 * WebSocket opens a session may make. The client rotates to a new socket every
 * 1 MB, so a full byte budget needs 512 opens; this leaves margin for retries.
 * Opens are counted rather than concurrent sockets because the free plan sheds
 * sockets abruptly and a close event isn't guaranteed.
 */
export const SESSION_MAX_OPENS = 1024;

export interface BudgetState { bytes: number; opens: number }

/** Count one WebSocket open. False (and nothing counted) once opens or bytes are used up. */
export function tryOpen(s: BudgetState, maxOpens = SESSION_MAX_OPENS, maxBytes = SESSION_MAX_BYTES): boolean {
  if (s.opens >= maxOpens || s.bytes >= maxBytes) return false;
  s.opens++;
  return true;
}

/**
 * Add transferred bytes. True while budget remains; false once the total has
 * reached the limit. Zero, negative and non-finite reports are ignored.
 */
export function addBytes(s: BudgetState, n: number, maxBytes = SESSION_MAX_BYTES): boolean {
  if (Number.isFinite(n) && n > 0) s.bytes += n;
  return s.bytes < maxBytes;
}

/** The nonce of a "<expires>.<nonce>.<hmac>" token. Call only after the token's HMAC has been checked. */
export function sessionNonce(token: string): string | null {
  const p = token.split('.');
  return p.length === 3 && p[1] ? p[1] : null;
}

/** The expiry (unix seconds) of a "<expires>.<nonce>.<hmac>" token, or null. */
export function sessionExpires(token: string): number | null {
  const n = Number(token.split('.')[0]);
  return Number.isFinite(n) ? n : null;
}
