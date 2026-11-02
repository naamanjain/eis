'use strict';
// Newest-wins bookkeeping. A panel can hold exactly one live request; anything
// older is either aborted or ignored, so a slow answer can never overwrite a
// faster one that arrived after it.

const { CancelledError } = require('../errors');

class Ledger {
  constructor() {
    this.active = null;
    this.counter = 0;
  }

  begin(label) {
    this.counter += 1;
    const id = `${label || 'request'}:${this.counter}`;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;

    if (this.active) {
      const previous = this.active;
      try {
        previous.controller?.abort(new CancelledError('Superseded by a newer request.'));
      } catch (error) {
        // an abort that fails is not worth losing the new request over
      }
      previous.superseded = true;
    }

    const entry = {
      id,
      label: label || 'request',
      controller,
      signal: controller ? controller.signal : null,
      startedAt: Date.now(),
      superseded: false,
    };
    this.active = entry;
    return {
      id,
      signal: entry.signal,
      // Callers check this before touching UI state.
      isCurrent: () => this.active === entry && !entry.superseded,
      cancel: (reason) => this.cancel(id, reason),
    };
  }

  cancel(id, reason) {
    const entry = this.active;
    if (!entry || (id && entry.id !== id)) return false;
    entry.superseded = true;
    try {
      entry.controller?.abort(reason instanceof Error ? reason : new CancelledError(String(reason || 'Cancelled.')));
    } catch (error) {
      // ignore
    }
    if (this.active === entry) this.active = null;
    return true;
  }

  cancelAll() {
    if (!this.active) return 0;
    this.cancel(this.active.id, 'The panel was closed.');
    return 1;
  }

  currentId() {
    return this.active ? this.active.id : null;
  }
}

module.exports = { Ledger };
