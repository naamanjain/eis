'use strict';
// Backend security middleware: headers, a bounded in-memory rate limiter, and an
// optional access token. No dependencies, because this has to run on a plain
// `npm install express`.

const { ERROR_CODES, ApiError } = require('../errors');

// ---- headers ---------------------------------------------------------------

function createSecurityHeaders(config) {
  const csp = [
    "default-src 'self'",
    // The demo page and the app both use inline styles; scripts are external.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "script-src 'self'",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(self), camera=(), payment=(), usb=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    // Cache only per-client, and never let a proxy hold an explanation.
    res.setHeader('Cache-Control', 'no-store');
    if (config.accessToken) res.setHeader('Vary', 'Authorization');
    next();
  };
}

// ---- origin control --------------------------------------------------------

function createCors(config) {
  const allowed = new Set(config.allowedOrigins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Eis-Token');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(allowed.size && origin && allowed.has(origin) ? 204 : 403);
      return undefined;
    }
    return next();
  };
}

// ---- access token ----------------------------------------------------------

// Same-origin requests (the served frontend) need nothing; anything else that
// arrives when a token is configured must present it.
function createAccessGate(config) {
  return (req, res, next) => {
    if (!config.accessToken) return next();
    const header = String(req.headers.authorization || '');
    // Deliberately not accepted in a query string: URLs land in server, proxy and CI
    // logs, and browser history, so a token there is a token leaked.
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (provided && timingSafeEqual(provided, config.accessToken)) return next();
    return next(new ApiError(ERROR_CODES.AUTHENTICATION, 'This endpoint requires an access token.', 401));
  };
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  const crypto = require('crypto');
  return crypto.timingSafeEqual(left, right);
}

// ---- rate limit ------------------------------------------------------------

// Sliding-window counter per bucket with a small burst allowance. Buckets are
// evicted when idle so the map cannot grow without bound.
function createRateLimiter(config) {
  const { requests, windowMs, burst } = config.rateLimit;
  const trustProxy = config.trustProxy || 0;
  const hits = new Map();
  let lastSweep = Date.now();

  function sweep(now) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [key, entry] of hits) {
      if (now - entry.windowStart > windowMs * 2) hits.delete(key);
    }
  }

  return (req, res, next) => {
    const now = Date.now();
    sweep(now);
    const bucket = rateKey(req, trustProxy);
    let entry = hits.get(bucket);
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { windowStart: now, count: 0 };
      hits.set(bucket, entry);
    }
    entry.count += 1;

    res.setHeader('X-RateLimit-Limit', String(requests));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, requests - entry.count)));

    const limit = requests + burst;
    if (entry.count > limit) {
      const retryMs = Math.max(1000, entry.windowStart + windowMs - now);
      res.setHeader('Retry-After', String(Math.ceil(retryMs / 1000)));
      return next(new ApiError(
        ERROR_CODES.RATE_LIMIT,
        `Too many requests from this address. Try again in ${Math.ceil(retryMs / 1000)}s.`,
        429,
      ));
    }
    return next();
  };
}

// Clients can put anything in X-Forwarded-For, so it is only consulted when the
// operator says how many trusted proxies sit in front (`EIS_TRUST_PROXY`). With no
// trusted proxy, the socket address is the only honest signal. `req.method` is
// deliberately NOT part of the bucket: splitting it would double everyone's budget.
function clientAddress(req, trustProxy = 0) {
  const socket = req.socket || {};
  const peer = socket.remoteAddress || 'unknown';
  if (!trustProxy) return peer;
  const list = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!list.length) return peer;
  // Rightmost entry is the one our trusted proxy appended.
  const index = list.length - trustProxy;
  return index >= 0 ? list[index] : list[0];
}

function rateKey(req, trustProxy = 0) {
  return clientAddress(req, trustProxy);
}

// ---- concurrency ---------------------------------------------------------

// A provider call is slow and costs money. Without a ceiling, one determined
// client (or one retrying client) can hold the process open with dozens of
// simultaneous upstream requests.
function createInflightLimiter(config) {
  const max = config.maxInflight;
  let active = 0;
  const middleware = (req, res, next) => {
    if (max > 0 && active >= max) {
      res.setHeader('Retry-After', '2');
      res.setHeader('X-Inflight-Limit', String(max));
      return next(new ApiError(ERROR_CODES.RATE_LIMIT, `This server handles ${max} request(s) at a time. Try again in a moment.`, 429));
    }
    active += 1;
    res.setHeader('X-Inflight', String(active));
    let counted = true;
    const release = () => {
      if (!counted) return;
      counted = false;
      active -= 1;
    };
    res.on('finish', release);
    res.on('close', release);
    return next();
  };
  middleware.active = () => active;
  middleware.reset = () => {
    active = 0;
  };
  return middleware;
}

// ---- daily budget --------------------------------------------------------

// A coarse spend guard, not billing: it stops a forgotten deployment from
// exhausting the key. Buckets are per UTC day and held in memory.
function describeWait(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.ceil((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

function createDailyBudget(config) {
  const cap = config.dailyRequestCap;
  const state = { day: currentDay(), count: 0 };

  function currentDay() {
    return new Date().toISOString().slice(0, 10);
  }

  const middleware = (req, res, next) => {
    const day = currentDay();
    if (day !== state.day) {
      state.day = day;
      state.count = 0;
    }
    if (cap > 0 && state.count >= cap) {
      // The budget rolls at UTC midnight, so the wait is computable. Without Retry-After
      // a client sees retryable:true and an honest-looking "Try again" button that cannot
      // possibly work until the day turns over.
      const now = new Date();
      const nextDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      const retrySeconds = Math.max(1, Math.ceil((nextDay - now.getTime()) / 1000));
      res.setHeader('Retry-After', String(retrySeconds));
      return next(new ApiError(
        ERROR_CODES.RATE_LIMIT,
        `This server has served its daily budget of ${cap} explanation requests. It resets in ${describeWait(retrySeconds)}, or the operator can raise EIS_DAILY_REQUEST_CAP.`,
        429,
      ));
    }
    state.count += 1;
    res.setHeader('X-Daily-Request-Remaining', String(cap > 0 ? Math.max(0, cap - state.count) : 'unlimited'));
    return next();
  };
  middleware.count = () => state.count;
  middleware.reset = () => {
    state.count = 0;
  };
  return middleware;
}

module.exports = {
  createSecurityHeaders,
  createCors,
  createAccessGate,
  createRateLimiter,
  createInflightLimiter,
  createDailyBudget,
  clientAddress,
  rateKey,
  timingSafeEqual,
};
