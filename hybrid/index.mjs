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

function hybridLog(message, details) {
  console.log('%c[Nexus:hybrid]', 'color:#34d399;font-weight:700', new Date().toISOString(), message, details || '');
}

function hybridWarn(message, details) {
  console.warn('%c[Nexus:hybrid]', 'color:#f97316;font-weight:700', new Date().toISOString(), message, details || '');
}

export default class HybridTransport {
  constructor(wispurl, bridgeurl) {
    this.http = new WispTransport({ wisp: String(wispurl || '') });
    this.bridge = new HttpBridgeTransport({ base: String(bridgeurl || '') });
    this.websocket = this.bridge;
    this.ready = false;
    hybridLog('constructed', {
      httpTransport: 'Wisp',
      websocketTransport: 'HTTP bridge',
      wisp: endpoint(wispurl),
      bridge: endpoint(bridgeurl),
    });
  }

  async init() {
    hybridLog('init.start', { http: 'Wisp', websocket: 'HTTP bridge' });
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

  request(remote, method, body, headers, signal) {
    const requestId = `http-${++hybridRequestSequence}`;
    hybridLog('request.start', { requestId, method, url: endpoint(remote.href) });
    return this.http.request(remote, method, body, headers, signal).then((response) => {
      hybridLog('request.wisp.complete', { requestId, status: response.status });
      return response;
    }).catch((error) => {
      hybridWarn('request.wisp.failed; using HTTP bridge fallback', { requestId, error: errorDetails(error) });
      return this.bridge.request(remote, method, body, headers, signal).then((response) => {
        hybridLog('request.httpbridge.complete', { requestId, status: response.status });
        return response;
      });
    });
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
