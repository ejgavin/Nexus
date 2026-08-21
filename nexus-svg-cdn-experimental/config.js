// ── Nexus transport config ───────────────────────────────────────────────────
// This file is shared by the window and service worker. Resolve every static
// asset from the directory containing this copy so the whole experiment can
// run below a CDN package path such as /gh/user/repo/.../nexus-svg-cdn-experimental/.
var _nexusBase = new URL('./', self.location.href).pathname;
// TRANSPORT_SERVER is the base URL of your bare/wisp backend.
// For local dev this is the same origin; for production set it to wherever
// your server.js is deployed (e.g. 'https://yourapp.koyeb.app').
//
// Override at deploy time by injecting:
//   <script>window.NEXUS_SERVER = 'https://yourserver.com';</script>
// BEFORE this file loads, or just hardcode the URL below.

var _server = (typeof window !== 'undefined' && window.NEXUS_SERVER)
  ? window.NEXUS_SERVER.replace(/\/+$/, '')
  : 'https://somestuffserver.koyeb.app';

// Koyeb serves the app over HTTPS, so the tunnel must use WSS. Keep support
// for plain HTTP local development and for an explicitly supplied ws:// URL.
var _serverHttp = _server.replace(/^ws(s?):/i, 'http$1:');
var _wsProtocol = /^https:/i.test(_serverHttp) ? 'wss' : 'ws';

var _CONFIG = {
  // Wisp WebSocket — handles all proxied TCP connections
  wispurl: _wsProtocol + '://' + _serverHttp.replace(/^https?:\/\//i, '') + '/wisp/',

  // Bare HTTP fallback — handles requests when Wisp isn't available
  bareurl: _serverHttp + '/api/bare/',

  // HTTP-streaming bridge. Full HTTP bridge mode is the default: it carries
  // both page requests and WebSocket traffic without initializing Wisp.
  // The optional WebSockets-only setting intentionally selects hybrid mode.
  bridgeurl: _serverHttp + '/api/wsbridge/',
  // Opt-in SSE WebSocket bridge. Page requests still use bridgeurl; only
  // WebSocket events/sends use this separate backend route when enabled.
  ssebridgeurl: _serverHttp + '/api/ssebridge/',

  // Optional DOM cleanup used inside proxied pages. The query-string/UI
  // setting can turn this on without changing the bundled request engine.
  elementRemoval: {
    defaultSelector: 'span.sc-3c372983-24.sc-90a29998-9.jWXiqP.ctujSw',
    defaultText: 'bypass by frogiesarcade.net | discord.gg/unblockedgames'
  },
};

// Scramjet engine config — read by both browser-side ScramjetController
// AND the service worker (via importScripts('/config.js') in 1k123.js).
self.__scramjet$config = {
  prefix: _nexusBase + 'math/',
  files: {
    wasm: _nexusBase + 'q9vx/sj.wasm.wasm',
    all:  _nexusBase + 'q9vx/sj.all.js',
    sync: _nexusBase + 'q9vx/sj.sync.js',
  }
};
