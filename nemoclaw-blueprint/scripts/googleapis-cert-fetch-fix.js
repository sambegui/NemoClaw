// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// googleapis-cert-fetch-fix.js — restore Google identity / JWT signing-cert
// fetches for the @openclaw/googlechat plugin inside NemoClaw sandboxes
// (NVIDIA/NemoClaw#4687).
//
// Problem:
//   The @openclaw/googlechat plugin verifies every inbound Google Chat
//   webhook by fetching Google's JWT signing certificates. Those fetches go
//   through OpenClaw's SSRF guard (fetchWithSsrFGuard), which pins a
//   per-request undici Dispatcher / http.Agent onto the fetch() call. That
//   per-request dispatcher bypasses both Node's global dispatcher and
//   NemoClaw's proxy routing (the http.request() hook in
//   nemoclaw-http-proxy-fix.js, loaded via NODE_OPTIONS=--require). The
//   result inside the sandbox:
//     - HTTPS_PROXY set   → per-request proxy agent → L7 proxy 403
//     - HTTPS_PROXY unset → per-request direct dispatcher → fetch failed (TCP)
//   so JWT verification fails and every inbound Google Chat message is
//   rejected with "Failed to retrieve verification certificates: fetch
//   failed".
//
//   The same request issued through the host's global dispatcher (plain
//   fetch / Gaxios default fetch) returns HTTP 200 — the global dispatcher is
//   exactly where NemoClaw's proxy routing lives.
//
// Fix:
//   Wrap fetch() and, for the small set of read-only Google identity /
//   signing-cert endpoints the plugin hardcodes, strip any per-request
//   `dispatcher` / `agent` so the request falls back to the host's global
//   dispatcher (issue fix shapes (a)+(b)). This is a narrow carve-out: only
//   the Google cert endpoints are affected, and the global dispatcher still
//   enforces the sandbox network policy at the proxy / netns layer — the
//   SSRF guard's defense-in-depth is unchanged for every other host.
//
//   Both globalThis.fetch and the `undici` module's fetch export are wrapped
//   because the plugin's bundled gaxios / google-auth-library may reach
//   either, depending on how it resolves fetch.
//
// Remove this when @openclaw/googlechat (or OpenClaw's ssrf-runtime) reuses
// the host's global dispatcher instead of pinning a per-request one for
// these identity fetches.

(function () {
  'use strict';

  // Scoped strictly to the sandbox runtime, where the proxy routing lives.
  if (process.env.OPENSHELL_SANDBOX !== '1') return;

  // Google identity / JWT signing-cert hosts and path prefixes the
  // @openclaw/googlechat plugin fetches. These are read-only public Google
  // endpoints (constants in the plugin source).
  var CERT_HOSTS = { 'www.googleapis.com': true, 'googleapis.com': true };
  var CERT_PATH_PREFIXES = [
    '/oauth2/v1/certs',
    '/robot/v1/metadata/x509/',
    '/service_accounts/v1/metadata/x509/',
  ];

  function targetUrl(input) {
    try {
      if (typeof input === 'string') return new URL(input);
      if (input && typeof input === 'object') {
        if (typeof input.href === 'string' && typeof input.hostname === 'string') {
          return input; // already a URL
        }
        if (typeof input.url === 'string') return new URL(input.url); // Request
      }
    } catch (_e) {
      /* unparseable input — let the underlying fetch handle it */
    }
    return null;
  }

  function isGoogleCertEndpoint(url) {
    if (!url || !CERT_HOSTS[url.hostname]) return false;
    for (var i = 0; i < CERT_PATH_PREFIXES.length; i++) {
      if (url.pathname.indexOf(CERT_PATH_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  var _loggedStrip = false;

  function wrapFetch(origFetch) {
    if (typeof origFetch !== 'function' || origFetch.__nemoclawGoogleCertFix) {
      return origFetch;
    }
    var wrapped = function (input, init) {
      if (
        init &&
        typeof init === 'object' &&
        (init.dispatcher || init.agent) &&
        isGoogleCertEndpoint(targetUrl(input))
      ) {
        // Shallow-clone init and drop the per-request dispatcher / agent so
        // the request uses the host's global dispatcher (NemoClaw proxy
        // routing) instead of the SSRF guard's pinned one.
        var clone = {};
        for (var key in init) {
          if (Object.prototype.hasOwnProperty.call(init, key)) clone[key] = init[key];
        }
        delete clone.dispatcher;
        delete clone.agent;
        if (!_loggedStrip) {
          _loggedStrip = true;
          try {
            process.stderr.write(
              '[guard] googleapis-cert-fetch-fix: routing Google signing-cert ' +
                'fetch through host global dispatcher (nemoclaw #4687)\n',
            );
          } catch (_e) {}
        }
        return origFetch.call(this, input, clone);
      }
      return origFetch.call(this, input, init);
    };
    wrapped.__nemoclawGoogleCertFix = true;
    return wrapped;
  }

  if (typeof globalThis.fetch === 'function') {
    globalThis.fetch = wrapFetch(globalThis.fetch);
  }

  try {
    var undici = require('undici');
    if (undici && typeof undici.fetch === 'function') {
      undici.fetch = wrapFetch(undici.fetch);
    }
  } catch (_e) {
    /* undici not resolvable as a standalone module; global fetch covers it */
  }
})();
