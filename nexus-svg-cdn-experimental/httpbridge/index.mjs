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

let bridgeSocketSequence = 0;

function safeUrl(value) {
  try {
    const url = new URL(value);
    const queryKeys = [...url.searchParams.keys()];
    return `${url.protocol}//${url.host}${url.pathname}${queryKeys.length ? `?keys=${queryKeys.join(',')}` : ''}`;
  } catch (_) {
    return String(value || '').slice(0, 240);
  }
}

function errorDetails(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack ? String(error.stack).split('\n').slice(0, 3).join('\n') : undefined,
  };
}

function dataDetails(value) {
  const isText = typeof value === 'string';
  let bytes = 0;
  if (isText) bytes = new TextEncoder().encode(value).byteLength;
  else if (value?.byteLength != null) bytes = value.byteLength;
  else if (value?.size != null) bytes = value.size;
  return {
    type: isText ? 'text' : value?.constructor?.name || typeof value,
    bytes,
    preview: isText ? value.slice(0, 120).replace(/[\r\n]+/g, '\\n') : undefined,
  };
}

function bridgeLog(message, details) {
  console.log('%c[Nexus:httpbridge]', 'color:#34d399;font-weight:700', new Date().toISOString(), message, details || '');
}

function bridgeWarn(message, details) {
  console.warn('%c[Nexus:httpbridge]', 'color:#f97316;font-weight:700', new Date().toISOString(), message, details || '');
}

// The bridge normally returns JSON, but an intermediary can occasionally
// answer with an HTML error page or an empty body (for example during a cold
// deployment). Calling response.json() directly turns that useful transport
// failure into the unhelpful "JSON.parse: unexpected character" message.
// Read the body once, log a bounded preview, and keep the original status in
// the error that reaches Scramjet.
async function readJsonResponse(response, label, context) {
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  const normalized = text.replace(/^\uFEFF/, '').trim();
  if (!normalized) {
    bridgeWarn(`${label}: empty response`, {
      ...(context || {}),
      status: response.status,
      contentType,
    });
    throw new Error(`${label} returned an empty response (HTTP ${response.status})`);
  }
  try {
    return JSON.parse(normalized);
  } catch (error) {
    const preview = normalized.slice(0, 240).replace(/[\r\n]+/g, ' ');
    bridgeWarn(`${label}: non-JSON response`, {
      ...(context || {}),
      status: response.status,
      contentType,
      preview,
      parseError: errorDetails(error),
    });
    const detail = preview ? `: ${preview}` : '';
    const wrapped = new Error(`${label} returned non-JSON data (HTTP ${response.status})${detail}`);
    wrapped.cause = error;
    wrapped.status = response.status;
    throw wrapped;
  }
}

function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new DOMException('The operation was aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    function cancel() {
      clearTimeout(timer);
      reject(signal.reason || new DOMException('The operation was aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

async function fetchBridgeJson(url, options, label, context) {
  const maxAttempts = 3;
  const retryable = new Set([502, 503, 504]);
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options?.signal?.aborted) throw options.signal.reason || new DOMException('The operation was aborted', 'AbortError');
    let response;
    try {
      response = await fetch(url, options);
      const value = await readJsonResponse(response, label, context);
      if (retryable.has(response.status) && attempt < maxAttempts) {
        const delay = 250 * attempt;
        bridgeWarn(`${label}: retrying transient HTTP status`, {
          ...(context || {}),
          attempt,
          nextAttempt: attempt + 1,
          status: response.status,
          delayMs: delay,
        });
        await waitForRetry(delay, options?.signal);
        continue;
      }
      return { response, value };
    } catch (error) {
      lastError = error;
      const status = response?.status;
      if (attempt >= maxAttempts || (status != null && !retryable.has(status))) throw error;
      const delay = 250 * attempt;
      bridgeWarn(`${label}: retrying transient bridge failure`, {
        ...(context || {}),
        attempt,
        nextAttempt: attempt + 1,
        status,
        delayMs: delay,
        error: errorDetails(error),
      });
      await waitForRetry(delay, options?.signal);
    }
  }
  throw lastError || new Error(`${label} failed`);
}

async function readEvents(response, onEvent, signal, state) {
  if (!response.ok || !response.body) throw new Error(`HTTP event stream failed (${response.status})`);
  bridgeLog('event stream opened', { id: state.id, status: response.status, contentType: response.headers.get('content-type') || '', startedAt: state.startedAt });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    state.chunks += 1;
    state.streamBytes += value?.byteLength || 0;
    bridgeLog('event stream chunk', { id: state.id, chunk: state.chunks, bytes: value?.byteLength || 0, streamBytes: state.streamBytes });
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';
    for (const frame of frames) {
      state.frames += 1;
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) {
        let payload;
        try {
          payload = JSON.parse(data);
        } catch (error) {
          bridgeWarn('event frame JSON parse failed', { id: state.id, frame: state.frames, event, dataBytes: data.length, error: errorDetails(error) });
          continue;
        }
        state.events += 1;
        bridgeLog('event received', {
          id: state.id,
          event,
          sequence: state.events,
          bytes: payload && payload.data ? Math.floor(payload.data.length * 3 / 4) : 0,
          code: payload && payload.code,
          reason: payload && payload.reason,
        });
        try {
          onEvent(event, payload);
        } catch (error) {
          bridgeWarn('event callback threw', { id: state.id, event, error: errorDetails(error) });
          throw error;
        }
      }
    }
  }
  bridgeWarn('event stream ended', { id: state.id, aborted: signal.aborted, chunks: state.chunks, frames: state.frames, events: state.events, streamBytes: state.streamBytes });
}

export default class HttpBridgeTransport {
  constructor(options, websocketBase) {
    const config = options && typeof options === 'object'
      ? options
      : { base: options, websocketBase };
    this.base = String(config?.base || '').replace(/\/+$/, '');
    this.websocketBase = String(config?.websocketBase || this.base).replace(/\/+$/, '');
    this.ready = false;
  }

  async init() {
    if (!this.base) throw new Error('HTTP bridge endpoint is missing');
    this.ready = true;
    bridgeLog('transport initialized', {
      endpoint: safeUrl(this.base),
      websocketEndpoint: safeUrl(this.websocketBase),
      websocketMode: this.websocketBase !== this.base ? 'SSE WebSocket bridge' : 'HTTP bridge event stream',
      transport: 'HTTP bridge; no browser WebSocket opened',
    });
  }

  async meta() {}

  async request(remote, method, body, headers, signal) {
    const bytes = await toBytes(body);
    bridgeLog('HTTP request start', { method, url: safeUrl(remote.href), bodyBytes: bytes.length, headerCount: Object.keys(headerObject(headers)).length });
    const requestBody = JSON.stringify({
      url: remote.href,
      method,
      headers: headerObject(headers),
      body: bytes.length ? toBase64(bytes) : '',
    });
    const { response, value: result } = await fetchBridgeJson(`${this.base}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody,
      signal,
    }, 'HTTP bridge request', {
      method,
      url: safeUrl(remote.href),
    });
    if (!response.ok) {
      const message = result && typeof result.error === 'string' ? result.error : `HTTP bridge request failed (${response.status})`;
      bridgeWarn('HTTP request failed', { method, url: safeUrl(remote.href), status: response.status, error: message });
      throw new Error(message);
    }
    if (!result || typeof result !== 'object') {
      throw new Error('HTTP bridge request returned an invalid JSON payload');
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
    bridgeLog('HTTP request complete', { method, url: safeUrl(remote.href), status: resultResponse.status, bodyBytes: resultBytes.length });
    return {
      body: noBodyStatus ? null : resultBytes.buffer,
      headers: result.headers || {},
      status: resultResponse.status,
      statusText: resultResponse.statusText,
    };
  }

  connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
    const state = {
      id: `client-${Date.now().toString(36)}-${++bridgeSocketSequence}`,
      upstreamId: null,
      closed: false,
      abort: new AbortController(),
      events: 0,
      sends: 0,
      chunks: 0,
      frames: 0,
      streamBytes: 0,
      startedAt: new Date().toISOString(),
    };

    const run = async () => {
      try {
        const socketBase = this.websocketBase;
        const websocketMode = socketBase !== this.base ? 'SSE WebSocket bridge' : 'HTTP bridge event stream';
        bridgeLog('WebSocket bridge lifecycle: open.start', { id: state.id, url: safeUrl(url.href), protocols: protocols || [], headerCount: Object.keys(headerObject(requestHeaders)).length, websocketMode, endpoint: safeUrl(socketBase) });
        const { response: openResponse, value: opened } = await fetchBridgeJson(`${socketBase}/open`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: url.href, protocols }),
          signal: state.abort.signal,
        }, 'HTTP bridge WebSocket open', {
          id: state.id,
          url: safeUrl(url.href),
        });
        bridgeLog('WebSocket bridge lifecycle: open.response', { id: state.id, status: openResponse.status, ok: openResponse.ok, contentType: openResponse.headers.get('content-type') || '' });
        if (!openResponse.ok) {
          const message = opened && typeof opened.error === 'string' ? opened.error : `HTTP bridge open failed (${openResponse.status})`;
          bridgeWarn('WebSocket bridge lifecycle: open.rejected', { id: state.id, url: safeUrl(url.href), status: openResponse.status, error: message });
          throw new Error(message);
        }
        if (!opened || typeof opened !== 'object' || !opened.id || !opened.events) {
          throw new Error('HTTP bridge WebSocket open returned an invalid JSON payload');
        }
        state.upstreamId = opened.id;
        bridgeLog('WebSocket bridge lifecycle: open.accepted', { id: state.id, upstreamId: state.upstreamId, events: safeUrl(new URL(opened.events, socketBase + '/').href), protocol: opened.protocol || '', websocketMode });

        bridgeLog('WebSocket bridge lifecycle: events.start', { id: state.id, upstreamId: state.upstreamId });
        const eventResponse = await fetch(new URL(opened.events, socketBase + '/').href, {
          signal: state.abort.signal,
          cache: 'no-store',
        });
        await readEvents(eventResponse, (event, payload) => {
          if (event === 'open') {
            bridgeLog('WebSocket bridge lifecycle: upstream.open', { id: state.id, upstreamId: state.upstreamId, protocol: payload.protocol || '' });
            onopen(payload.protocol || '');
          }
          else if (event === 'message') {
            const bytes = fromBase64(payload.data || '');
            const value = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            // Preserve the WebSocket message type. Twitch IRC/chat frames
            // are text and its parser expects a string (it calls split()).
            // Only binary frames should arrive as ArrayBuffer values.
            const message = payload.binary ? value : new TextDecoder().decode(bytes);
            bridgeLog('WebSocket bridge lifecycle: upstream.message', { id: state.id, upstreamId: state.upstreamId, sequence: state.events, binary: !!payload.binary, ...dataDetails(message) });
            onmessage(message);
          } else if (event === 'close') {
            bridgeWarn('WebSocket bridge lifecycle: upstream.close', { id: state.id, upstreamId: state.upstreamId, code: payload.code || 1000, reason: payload.reason || '' });
            onclose(payload.code || 1000, payload.reason || '');
          } else if (event === 'error') {
            bridgeWarn('WebSocket bridge lifecycle: upstream.error', { id: state.id, upstreamId: state.upstreamId, message: payload.message || '' });
            onerror(new Error(payload.message || 'HTTP bridge WebSocket error'));
          }
        }, state.abort.signal, state);
      } catch (error) {
        if (!state.closed && !state.abort.signal.aborted) {
          bridgeWarn('WebSocket bridge lifecycle: failed', { id: state.id, upstreamId: state.upstreamId, error: errorDetails(error) });
          onerror(error);
          onclose(1006, error.message || 'HTTP bridge disconnected');
        }
      }
    };
    run();

    return [
      async (data) => {
        if (!state.upstreamId || state.closed) {
          bridgeWarn('WebSocket bridge lifecycle: send.rejected', { id: state.id, upstreamId: state.upstreamId, closed: state.closed });
          throw new Error('HTTP bridge WebSocket is not open');
        }
        const bytes = await toBytes(data);
        state.sends += 1;
        bridgeLog('WebSocket bridge lifecycle: send.start', { id: state.id, upstreamId: state.upstreamId, sequence: state.sends, ...dataDetails(data), binary: typeof data !== 'string' });
        const response = await fetch(`${this.websocketBase}/send/${state.upstreamId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: toBase64(bytes), binary: typeof data !== 'string' }),
        });
        if (!response.ok) {
          bridgeWarn('WebSocket bridge lifecycle: send.failed', { id: state.id, upstreamId: state.upstreamId, sequence: state.sends, status: response.status });
          throw new Error(`WebSocket bridge send failed (${response.status})`);
        }
        bridgeLog('WebSocket bridge lifecycle: send.complete', { id: state.id, upstreamId: state.upstreamId, sequence: state.sends, status: response.status });
      },
      async (code = 1000, reason = '') => {
        if (state.closed) return;
        state.closed = true;
        bridgeLog('WebSocket bridge lifecycle: close.start', { id: state.id, upstreamId: state.upstreamId, code, reason });
        state.abort.abort();
        if (state.upstreamId) {
          await fetch(`${this.websocketBase}/close/${state.upstreamId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, reason }),
          }).then((response) => {
            bridgeLog('WebSocket bridge lifecycle: close.complete', { id: state.id, upstreamId: state.upstreamId, status: response.status });
          }).catch((error) => {
            bridgeWarn('WebSocket bridge lifecycle: close.failed', { id: state.id, upstreamId: state.upstreamId, error: errorDetails(error) });
          });
        }
      },
    ];
  }
}
