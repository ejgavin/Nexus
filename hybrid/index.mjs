// Hybrid transport: Wisp handles normal HTTP requests while the HTTP bridge
// handles WebSocket connections.
import WispTransport from '../e7px/index.mjs';
import HttpBridgeTransport from '../httpbridge/index.mjs';

let hybridRequestSequence = 0;
let hybridSocketSequence = 0;

function endpoint(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch (_) {
    return String(value || '').slice(0, 240);
  }
}

function errorDetails(error) {
  return { name: error?.name || 'Error', message: error?.message || String(error) };
}

function responsePreview(response) {
  const body = response?.body;
  if (!body) return '';
  try {
    const bytes = body instanceof Uint8Array
      ? body
      : body instanceof ArrayBuffer
        ? new Uint8Array(body)
        : ArrayBuffer.isView(body)
          ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
          : null;
    return bytes ? new TextDecoder().decode(bytes.subarray(0, 512)) : '';
  } catch (_) {
    return '';
  }
}

function looksLikeTransportFailure(response, method) {
  const status = Number(response?.status || 0);
  // Epoxy/Wisp can surface a network failure as a response-shaped object with
  // status 0. Passing that through makes Scramjet construct an invalid native
  // Response and produces a misleading status-range exception.
  if (status < 200 || status > 599) return true;
  // GET/HEAD/OPTIONS are safe to replay. A transport proxy can turn an
  // otherwise healthy asset into a generic 500, so do not require a specific
  // error-body string before trying the alternate path. If the alternate
  // path returns the same real upstream 500, that response is still returned.
  return status >= 500 && status <= 599 && /^(GET|HEAD|OPTIONS)$/i.test(String(method || 'GET'));
}

function hybridLog(message, details) {
  console.log('%c[Nexus:hybrid]', 'color:#34d399;font-weight:700', new Date().toISOString(), message, details || '');
}

function hybridWarn(message, details) {
  console.warn('%c[Nexus:hybrid]', 'color:#f97316;font-weight:700', new Date().toISOString(), message, details || '');
}

export default class HybridTransport {
  constructor(wispurl, bridgeurl, ssebridgeurl) {
    this.http = new WispTransport({ wisp: String(wispurl || '') });
    this.bridge = new HttpBridgeTransport({ base: String(bridgeurl || ''), websocketBase: String(ssebridgeurl || bridgeurl || '') });
    this.websocket = this.bridge;
    this.ready = false;
    this.wispUnavailable = false;
    this.bridgeTimeoutMs = 5000;
    hybridLog('constructed', {
      httpTransport: 'Wisp',
      websocketTransport: ssebridgeurl ? 'SSE WebSocket bridge' : 'HTTP bridge event stream',
      wisp: endpoint(wispurl),
      bridge: endpoint(bridgeurl),
      sseBridge: endpoint(ssebridgeurl || bridgeurl),
    });
  }

  async init() {
    hybridLog('init.start', { http: 'Wisp', websocket: this.bridge.websocketBase !== this.bridge.base ? 'SSE WebSocket bridge' : 'HTTP bridge event stream' });
    const httpInit = this.http.init().then(() => hybridLog('init.wisp.ready', { endpoint: endpoint(this.http.wisp) }));
    const bridgeInit = this.bridge.init().then(() => hybridLog('init.httpbridge.ready', { endpoint: endpoint(this.bridge.base) }));
    try {
      await Promise.all([httpInit, bridgeInit]);
    } catch (error) {
      hybridWarn('init.failed', errorDetails(error));
      throw error;
    }
    this.ready = true;
    hybridLog('init.complete', { ready: this.ready });
  }

  async meta() {
    hybridLog('meta.start');
    if (this.http.meta) await this.http.meta();
    hybridLog('meta.complete');
  }

  async request(remote, method, body, headers, signal) {
    const requestId = `http-${++hybridRequestSequence}`;
    hybridLog('request.start', { requestId, method, url: endpoint(remote.href) });

    const bridgeRequest = async (reason) => {
      const controller = new AbortController();
      const abortBridge = () => controller.abort();
      let timeoutId;
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', abortBridge, { once: true });
      }
      timeoutId = setTimeout(() => controller.abort(), this.bridgeTimeoutMs);
      try {
        hybridLog('request.httpbridge.start', { requestId, reason, url: endpoint(remote.href) });
        const response = await this.bridge.request(remote, method, body, headers, controller.signal);
        hybridLog('request.httpbridge.complete', { requestId, status: response.status });
        return response;
      } finally {
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', abortBridge);
      }
    };

    const alternateRequest = async (reason) => {
      try {
        return await bridgeRequest(reason);
      } catch (error) {
        hybridWarn('request.httpbridge.failed', { requestId, error: errorDetails(error) });
        throw error;
      }
    };

    if (this.wispUnavailable) {
      return alternateRequest('Wisp previously failed');
    }

    try {
      const response = await this.http.request(remote, method, body, headers, signal);
      if (looksLikeTransportFailure(response, method)) {
        this.wispUnavailable = true;
        hybridWarn('request.wisp returned transport-like failure; switching session to HTTP bridge', {
          requestId,
          status: response.status,
          preview: responsePreview(response).slice(0, 160),
        });
        return alternateRequest('Wisp returned ' + response.status);
      }
      hybridLog('request.wisp.complete', { requestId, status: response.status });
      return response;
    } catch (error) {
      this.wispUnavailable = true;
      hybridWarn('request.wisp.failed; using HTTP bridge fallback', { requestId, error: errorDetails(error) });
      return alternateRequest('Wisp request failed');
    }
  }

  connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
    const socketId = `hybrid-ws-${++hybridSocketSequence}`;
    hybridLog('websocket.route', {
      socketId,
      selected: 'HTTP bridge',
      browserWebSocketOpened: false,
      url: endpoint(url.href),
      protocols: protocols || [],
    });
    try {
      const handlers = this.websocket.connect(
        url,
        protocols,
        requestHeaders,
        (protocol) => { hybridLog('websocket.upstream.open', { socketId, protocol: protocol || '' }); onopen(protocol); },
        (data) => { hybridLog('websocket.upstream.message', { socketId, bytes: data?.byteLength ?? data?.length ?? 0, type: typeof data }); onmessage(data); },
        (code, reason) => { hybridWarn('websocket.upstream.close', { socketId, code, reason: reason || '' }); onclose(code, reason); },
        (error) => { hybridWarn('websocket.upstream.error', { socketId, error: errorDetails(error) }); onerror(error); },
      );
      hybridLog('websocket.route.ready', { socketId, handlers: Array.isArray(handlers) ? handlers.length : typeof handlers });
      return handlers;
    } catch (error) {
      hybridWarn('websocket.route.failed', { socketId, error: errorDetails(error) });
      throw error;
    }
  }
}
