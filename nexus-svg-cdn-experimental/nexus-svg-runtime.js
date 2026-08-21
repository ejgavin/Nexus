/*
 * Nexus SVG/CDN experiment.
 * The SVG shell and this file can be served from jsDelivr. The actual
 * Scramjet page remains on APP_ORIGIN because service workers and SharedWorker
 * transport must stay on one origin.
 */
(() => {
  'use strict';

  const cfg = window.__NEXUS_SVG__ || {};
  const query = new URLSearchParams(location.search);
  const appOrigin = (query.get('app') || location.origin).replace(/\/+$/, '');
  const runtimeRoot = (query.get('runtime') || cfg.cdn || appOrigin).replace(/\/+$/, '');
  const backend = (query.get('backend') || 'https://somestuffserver.koyeb.app').replace(/\/+$/, '');
  const bridge = backend + '/api/wsbridge/';
  const root = document.getElementById('nexus-svg-root');
  if (!root) return;

  const safeOrigin = value => {
    try { return new URL(value).origin; } catch (_) { return location.origin; }
  };
  const app = safeOrigin(appOrigin);
  const b64url = value => {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return 'b64.' + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  const shellMarkup = `
    <div class="svg-app">
      <header class="svg-top">
        <div class="svg-brand"><div class="svg-mark">N</div><div>Nexus<small>SVG CDN EXPERIMENT</small></div></div>
        <form class="svg-address" id="svg-form">
          <span>https://</span><input id="svg-url" autocomplete="off" spellcheck="false" placeholder="Enter any URL" aria-label="Address" />
          <button class="svg-go" type="submit">GO</button>
        </form>
        <div class="svg-actions">
          <button class="svg-icon" id="svg-back" title="Back" aria-label="Back">‹</button>
          <button class="svg-icon" id="svg-forward" title="Forward" aria-label="Forward">›</button>
          <button class="svg-icon" id="svg-reload" title="Reload" aria-label="Reload">↻</button>
          <button class="svg-icon" id="svg-home-btn" title="Home" aria-label="Home">⌂</button>
          <button class="svg-icon" id="svg-settings-btn" title="Settings" aria-label="Settings">⚙</button>
        </div>
      </header>
      <main class="svg-main">
        <section class="svg-home" id="svg-home">
          <div class="svg-home-card">
            <div class="svg-kicker">Nexus / experimental shell</div>
            <h1>Open a page</h1>
            <p>This entry point is an SVG document. Its UI runtime is loaded from the configured CDN while browsing stays in the regular Nexus engine.</p>
            <div class="svg-links">
              <button class="svg-link" data-url="https://www.youtube.com">YouTube</button>
              <button class="svg-link" data-url="https://www.google.com">Google</button>
              <button class="svg-link" data-url="https://www.twitch.tv">Twitch</button>
              <button class="svg-link" data-url="https://github.com">GitHub</button>
            </div>
          </div>
        </section>
        <iframe class="svg-view" id="svg-view" title="Nexus browsing area" allow="fullscreen *; autoplay *"></iframe>
        <div class="svg-status" id="svg-status"><span class="svg-dot"></span><span id="svg-status-text">Ready</span></div>
        <aside class="svg-settings" id="svg-settings">
          <h3>SVG shell settings</h3>
          <label class="svg-setting"><input id="svg-adblock" type="checkbox" checked /><span>Keep the built-in ad blocker enabled</span></label>
          <label class="svg-setting"><input id="svg-httpbridge" type="checkbox" checked /><span>Use HTTP bridge for new pages</span></label>
          <p class="svg-note">The app origin is <span id="svg-app-origin"></span>. Set <code>app=</code> when the SVG is hosted somewhere else.</p>
        </aside>
      </main>
    </div>`;
  // The outer document is XML. Parse the UI as HTML first so ordinary HTML
  // markup such as input/iframe elements is accepted by Firefox as well as
  // Chromium, then import the XHTML nodes into the foreignObject.
  const parsedShell = new DOMParser().parseFromString(shellMarkup, 'text/html');
  root.replaceChildren(...Array.from(parsedShell.body.childNodes).map(node => document.importNode(node, true)));

  const frame = document.getElementById('svg-view');
  const home = document.getElementById('svg-home');
  const input = document.getElementById('svg-url');
  const status = document.getElementById('svg-status');
  const statusText = document.getElementById('svg-status-text');
  const settings = document.getElementById('svg-settings');
  const adblock = document.getElementById('svg-adblock');
  const httpbridge = document.getElementById('svg-httpbridge');
  document.getElementById('svg-app-origin').textContent = app;

  let statusTimer;
  const setStatus = (text, visible = true) => {
    statusText.textContent = text;
    status.classList.toggle('show', visible);
    clearTimeout(statusTimer);
    if (visible) statusTimer = setTimeout(() => status.classList.remove('show'), 2400);
  };
  const normalize = value => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw;
      const url = new URL(candidate);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch (_) {}
    return 'https://safe.duckduckgo.com/?q=' + encodeURIComponent(raw);
  };
  const embedUrl = target => {
    const params = new URLSearchParams({ clean: '1', httpbridge: httpbridge.checked ? '1' : '0', adblock: adblock.checked ? '1' : '0' });
    return app + '/embed.html?' + params + '#' + b64url(target);
  };
  const navigate = value => {
    const target = normalize(value);
    if (!target) return;
    input.value = target.replace(/^https?:\/\//i, '');
    home.style.display = 'none';
    setStatus('Loading…');
    frame.src = embedUrl(target);
  };
  const send = (cmd, extra = {}) => {
    if (!frame.contentWindow) return;
    frame.contentWindow.postMessage({ type: 'nexus-cmd', cmd, ...extra }, '*');
  };

  document.getElementById('svg-form').addEventListener('submit', event => { event.preventDefault(); navigate(input.value); });
  document.querySelectorAll('[data-url]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.url)));
  document.getElementById('svg-back').addEventListener('click', () => send('back'));
  document.getElementById('svg-forward').addEventListener('click', () => send('forward'));
  document.getElementById('svg-reload').addEventListener('click', () => send('reload'));
  document.getElementById('svg-home-btn').addEventListener('click', () => { send('home'); home.style.display = 'grid'; });
  document.getElementById('svg-settings-btn').addEventListener('click', () => settings.classList.toggle('open'));
  window.addEventListener('message', event => {
    const data = event.data || {};
    if (data.type === 'nexus-nav' && data.url) {
      input.value = String(data.url).replace(/^https?:\/\//i, '');
      home.style.display = 'none';
      setStatus(data.title || 'Ready', true);
    } else if (data.type === 'nexus-error') {
      setStatus('Transport error: ' + (data.message || 'unknown error'), true);
    } else if (data.type === 'nexus-restricted') {
      setStatus('Domain locked', true);
    }
  });
  frame.addEventListener('load', () => setStatus('Ready', false));

  // Load the CDN copy of bare-mux for the shell. The embedded Nexus page
  // loads its own same-origin runtime and service worker from APP_ORIGIN.
  const mux = document.createElement('script');
  mux.src = runtimeRoot + '/m4thx/index.js?rev=' + encodeURIComponent(cfg.revision || 'svg-v1');
  mux.onload = async () => {
    try {
      if (window.BareMux?.BareMuxConnection) {
        const connection = new window.BareMux.BareMuxConnection(app + '/m4thx/worker.js');
        await connection.setTransport(app + '/httpbridge/index.mjs', [bridge]);
        console.info('[Nexus:svg] HTTP bridge responder ready', { app, bridge, cdn: cfg.cdn });
      }
      setStatus('Ready', false);
    } catch (error) {
      console.warn('[Nexus:svg] shell transport responder unavailable; embed will negotiate independently', error);
      setStatus('Ready', false);
    }
  };
  mux.onerror = () => {
    console.warn('[Nexus:svg] CDN bare-mux asset failed to load', mux.src);
    setStatus('CDN runtime unavailable', true);
  };
  document.body.appendChild(mux);
})();
