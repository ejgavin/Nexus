// Experimental HTTP replacement for the WebSocket-facing transport.
// The backend keeps the real upstream WebSocket open. This client uses:
//   GET  /events/:id  (SSE-like streamed response, downstream)
//   POST /send/:id    (upstream data)
// It implements the same transport shape as e7px/l9cx for bare-mux.

function toBase64(bytes) {
  let text = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    text += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(text);
}

function fromBase64(value) {
  const text = atob(value);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

async function toBytes(value) {
  if (value == null) return new Uint8Array();
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(await new Response(value).arrayBuffer());
}

function headerObject(headers) {
  return headers instanceof Headers ? Object.fromEntries(headers.entries()) : { ...(headers || {}) };
}

function bridgeLog(message, details) {
  console.log('%c[Nexus:httpbridge]', 'color:#34d399;font-weight:700', message, details || '');
}

function bridgeWarn(message, details) {
  console.warn('%c[Nexus:httpbridge]', 'color:#f97316;font-weight:700', message, details || '');
}

async function readEvents(response, onEvent, signal, state) {
  if (!response.ok || !response.body) throw new Error(`HTTP event stream failed (${response.status})`);
  bridgeLog('event stream opened', { id: state.id, status: response.status });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';
    for (const frame of frames) {
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) {
        const payload = JSON.parse(data);
        state.events += 1;
        bridgeLog('event received', {
          id: state.id,
          event,
          sequence: state.events,
          bytes: payload && payload.data ? Math.floor(payload.data.length * 3 / 4) : 0,
          code: payload && payload.code,
          reason: payload && payload.reason,
        });
        onEvent(event, payload);
      }
    }
  }
  bridgeWarn('event stream ended', { id: state.id, aborted: signal.aborted });
}

export default class HttpBridgeTransport {
  constructor(options) {
    this.base = String(options?.base || options || '').replace(/\/+$/, '');
    this.ready = false;
  }

  async init() {
    if (!this.base) throw new Error('HTTP bridge endpoint is missing');
    this.ready = true;
    bridgeLog('transport initialized', { endpoint: this.base });
  }

  async meta() {}

  async request(remote, method, body, headers, signal) {
    const bytes = await toBytes(body);
    bridgeLog('HTTP request start', { method, url: remote.href, bodyBytes: bytes.length, headerCount: Object.keys(headerObject(headers)).length });
    const response = await fetch(`${this.base}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: remote.href,
        method,
        headers: headerObject(headers),
        body: bytes.length ? toBase64(bytes) : '',
      }),
      signal,
    });
    const result = await response.json();
    if (!response.ok) {
      bridgeWarn('HTTP request failed', { method, url: remote.href, status: response.status, error: result.error || '' });
      throw new Error(result.error || `HTTP bridge request failed (${response.status})`);
    }
    const resultBytes = fromBase64(result.body || '');
    // 204/205/304 responses are not allowed to carry a body. Twitch uses
    // 204 responses for analytics calls during startup; constructing a
    // Response with bytes here crashes the service-worker fetch handler.
    const noBodyStatus = [204, 205, 304].includes(result.status);
    const resultResponse = new Response(noBodyStatus ? null : resultBytes, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
    bridgeLog('HTTP request complete', { method, url: remote.href, status: resultResponse.status, bodyBytes: resultBytes.length });
    return {
      body: noBodyStatus ? null : resultBytes.buffer,
      headers: result.headers || {},
      status: resultResponse.status,
      statusText: resultResponse.statusText,
    };
  }

  connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
    const state = {
      id: null,
      closed: false,
      abort: new AbortController(),
      events: 0,
      sends: 0,
    };

    const run = async () => {
      try {
        bridgeLog('WebSocket open requested', { url: url.href, protocols: protocols || [], headerCount: Object.keys(headerObject(requestHeaders)).length });
        const openResponse = await fetch(`${this.base}/open`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: url.href, protocols }),
          signal: state.abort.signal,
        });
        const opened = await openResponse.json();
        if (!openResponse.ok) {
          bridgeWarn('WebSocket open rejected', { url: url.href, status: openResponse.status, error: opened.error || '' });
          throw new Error(opened.error || `HTTP bridge open failed (${openResponse.status})`);
        }
        state.id = opened.id;
        bridgeLog('WebSocket open accepted', { id: state.id, events: opened.events, protocol: opened.protocol || '' });

        const eventResponse = await fetch(new URL(opened.events, this.base + '/').href, {
          signal: state.abort.signal,
          cache: 'no-store',
        });
        await readEvents(eventResponse, (event, payload) => {
          if (event === 'open') {
            bridgeLog('WebSocket opened upstream', { id: state.id, protocol: payload.protocol || '' });
            onopen(payload.protocol || '');
          }
          else if (event === 'message') {
            const bytes = fromBase64(payload.data || '');
            const value = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            // Preserve the WebSocket message type. Twitch IRC/chat frames
            // are text and its parser expects a string (it calls split()).
            // Only binary frames should arrive as ArrayBuffer values.
            onmessage(payload.binary ? value : new TextDecoder().decode(bytes));
          } else if (event === 'close') {
            bridgeWarn('WebSocket closed upstream', { id: state.id, code: payload.code || 1000, reason: payload.reason || '' });
            onclose(payload.code || 1000, payload.reason || '');
          } else if (event === 'error') {
            bridgeWarn('WebSocket upstream error', { id: state.id, message: payload.message || '' });
            onerror(new Error(payload.message || 'HTTP bridge WebSocket error'));
          }
        }, state.abort.signal, state);
      } catch (error) {
        if (!state.closed && !state.abort.signal.aborted) {
          bridgeWarn('WebSocket bridge failed', { id: state.id, message: error && error.message || String(error) });
          onerror(error);
          onclose(1006, error.message || 'HTTP bridge disconnected');
        }
      }
    };
    run();

    return [
      async (data) => {
        if (!state.id || state.closed) throw new Error('HTTP bridge WebSocket is not open');
        const bytes = await toBytes(data);
        state.sends += 1;
        bridgeLog('WebSocket send start', { id: state.id, sequence: state.sends, bytes: bytes.length, binary: typeof data !== 'string' });
        const response = await fetch(`${this.base}/send/${state.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: toBase64(bytes), binary: typeof data !== 'string' }),
        });
        if (!response.ok) {
          bridgeWarn('WebSocket send failed', { id: state.id, sequence: state.sends, status: response.status });
          throw new Error(`HTTP bridge send failed (${response.status})`);
        }
        bridgeLog('WebSocket send complete', { id: state.id, sequence: state.sends, status: response.status });
      },
      async (code = 1000, reason = '') => {
        if (state.closed) return;
        state.closed = true;
        bridgeLog('WebSocket close requested', { id: state.id, code, reason });
        state.abort.abort();
        if (state.id) {
          await fetch(`${this.base}/close/${state.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, reason }),
          }).then((response) => {
            bridgeLog('WebSocket close complete', { id: state.id, status: response.status });
          }).catch((error) => {
            bridgeWarn('WebSocket close request failed', { id: state.id, message: error && error.message || String(error) });
          });
        }
      },
    ];
  }
}
