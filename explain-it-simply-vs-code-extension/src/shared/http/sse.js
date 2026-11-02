/* Vendored from ../shared/http/sse.js — do not edit here; run `npm run vendor`. */
'use strict';
// Incremental Server-Sent-Events decoder. Providers stream `event:`/`data:` frames
// split arbitrarily across TCP chunks, so this buffers until a blank line and then
// emits one object per frame. Handles CRLF, multi-line data and comment/heartbeat
// lines. No JSON parsing here — the caller knows the payload shape.

class SseDecoder {
  constructor(onEvent) {
    this._onEvent = onEvent;
    this._buffer = '';
  }

  push(chunk) {
    this._buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    // Frames are separated by a blank line; normalise CRLF/CR to LF.
    this._buffer = this._buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let boundary;
    while ((boundary = this._buffer.indexOf('\n\n')) !== -1) {
      const frame = this._buffer.slice(0, boundary);
      this._buffer = this._buffer.slice(boundary + 2);
      this._emit(frame);
    }
  }

  flush() {
    const rest = this._buffer.trim();
    this._buffer = '';
    if (rest) this._emit(rest);
  }

  _emit(frame) {
    if (!frame.trim()) return;
    let event = 'message';
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (!line || line.startsWith(':')) continue; // heartbeat / comment
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value || 'message';
      else if (field === 'data') dataLines.push(value);
    }
    if (!dataLines.length) return;
    this._onEvent({ event, data: dataLines.join('\n') });
  }
}

module.exports = { SseDecoder };
