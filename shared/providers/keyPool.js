'use strict';
// Credential pool for deployments that hold more than one provider key.
//
// Rotation is a reliability concern, not a quota feature: when a provider says the
// key is invalid or rate limited, the next request should not fail the same way.
// Only those two classes mark a key unhealthy; a bad model id, an unreadable reply
// or a cancelled request says nothing about the credential.

const { ERROR_CODES } = require('../errors');

const DEFAULT_COOLDOWN_MS = 60_000;
const AUTH_PENALTY_MS = 5 * 60_000;

class KeyPool {
  constructor(keys = [], options = {}) {
    const clean = (Array.isArray(keys) ? keys : [keys])
      .map((key) => String(key == null ? '' : key).trim())
      .filter(Boolean);
    this.keys = [...new Set(clean)];
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.authCooldownMs = options.authCooldownMs ?? AUTH_PENALTY_MS;
    this.now = options.now || Date.now;
    this.state = this.keys.map(() => ({ blockedUntil: 0, reason: null }));
  }

  get size() {
    return this.keys.length;
  }

  /**
   * Index of the next usable key.
   * @param {number[]} [skip] indexes already tried by this request
   */
  acquire(skip = []) {
    const now = this.now();
    const avoided = new Set(skip);
    for (let offset = 0; offset < this.keys.length; offset += 1) {
      const index = this._cursor ? (this._cursor + offset) % this.keys.length : offset;
      if (avoided.has(index)) continue;
      if (this.state[index].blockedUntil > now) continue;
      return index;
    }
    return -1;
  }

  /** Marks a key unhealthy. Returns the index cooled down, or -1 if not pooled. */
  penalize(index, code) {
    if (index < 0 || index >= this.keys.length) return -1;
    const permanent = code === ERROR_CODES.AUTHENTICATION;
    this.state[index] = {
      blockedUntil: this.now() + (permanent ? this.authCooldownMs : this.cooldownMs),
      reason: code,
    };
    return index;
  }

  release(index) {
    if (index >= 0 && index < this.keys.length) this.state[index] = { blockedUntil: 0, reason: null };
  }

  /** Should this error move the key aside? */
  static shouldRotate(error) {
    if (!error || !error.code) return false;
    return error.code === ERROR_CODES.AUTHENTICATION || error.code === ERROR_CODES.RATE_LIMIT;
  }

  status() {
    const now = this.now();
    return this.keys.map((key, index) => ({
      index,
      hint: `${key.slice(0, 4)}…${key.slice(-2)}`,
      blockedUntil: this.state[index].blockedUntil,
      blocked: this.state[index].blockedUntil > now,
      reason: this.state[index].reason,
    }));
  }

  /** Round-robins the starting point so a healthy pool is not always used in order. */
  advance() {
    this._cursor = this.keys.length ? ((this._cursor || 0) + 1) % this.keys.length : 0;
  }

  clear() {
    this.state = this.keys.map(() => ({ blockedUntil: 0, reason: null }));
  }
}

function parseKeyList(primary, extra) {
  const fromExtra = String(extra || '')
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set([String(primary || '').trim(), ...fromExtra].filter(Boolean))];
}

module.exports = { KeyPool, parseKeyList, DEFAULT_COOLDOWN_MS, AUTH_PENALTY_MS };
