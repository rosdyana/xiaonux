// The page's Content-Security-Policy. Used by vite preview (vite.config.ts)
// and by deploy.sh (Cloudflare Pages _headers). Pass the relay URL if any.
// Copyright (c) 2026 xiaonux authors. SPDX-License-Identifier: Apache-2.0
import { pathToFileURL } from 'node:url';

export function csp(relayUrl = '') {
  // Reduce to an origin: a trailing slash or path would narrow the source to
  // that path only, and anything odd (quotes, `;`) must not reach the header.
  const origin = relayUrl ? new URL(relayUrl).origin : '';
  const relay = origin ? [origin, origin.replace(/^http/, 'ws')] : [];
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com https://www.googletagmanager.com",
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://*.google-analytics.com https://*.googletagmanager.com",
    ["connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com", ...relay].join(' '),
    "frame-src https://challenges.cloudflare.com",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
  ].join('; ');
}
// `node web/csp.mjs [relayUrl]` prints the policy (for deploy.sh).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(csp(process.argv[2] ?? ''));
