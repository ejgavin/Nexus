// Hybrid transport: Wisp handles normal HTTP requests while the HTTP bridge
// handles WebSocket connections.
import WispTransport from '../e7px/index.mjs';
import HttpBridgeTransport from '../httpbridge/index.mjs';

export default class HybridTransport {
  constructor(wispurl, bridgeurl) {
    this.http = new WispTransport({ wisp: String(wispurl || '') });
    this.bridge = new HttpBridgeTransport({ base: String(bridgeurl || '') });
    this.websocket = this.bridge;
    this.ready = false;
  }

  async init() {
    console.log('%c[Nexus:hybrid]', 'color:#34d399;font-weight:700', 'initializing Wisp HTTP + HTTP bridge WebSocket transports');
    await Promise.all([this.http.init(), this.bridge.init()]);
    this.ready = true;
    console.log('%c[Nexus:hybrid]', 'color:#34d399;font-weight:700', 'hybrid transport ready');
  }

  async meta() {
    if (this.http.meta) await this.http.meta();
  }

  request(remote, method, body, headers, signal) {
    return this.http.request(remote, method, body, headers, signal).catch((error) => {
      console.warn('[Nexus] Wisp request failed; using HTTP bridge fallback', error);
      return this.bridge.request(remote, method, body, headers, signal);
    });
  }

  connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
    console.log('%c[Nexus:hybrid]', 'color:#34d399;font-weight:700', 'routing WebSocket through HTTP bridge', { url: url.href, protocols: protocols || [] });
    return this.websocket.connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror);
  }
}
