if (navigator.userAgent.includes('Firefox')) {
  Object.defineProperty(globalThis, 'crossOriginIsolated', {
    value: true,
    writable: false
  });
}

// ── debug logger ─────────────────────────────────────────────────────────
// Note: localStorage isn't available in a service worker, so this can't
// share the page's on/off toggle directly — it's just always on. Filter the
// console by "[Nexus:sw]" to isolate these from the parent/embed logs.
var L = (function () {
  function log(msg)  { console.log('%c[Nexus:sw]', 'color:#a78bfa;font-weight:700', msg, arguments.length > 1 ? Array.prototype.slice.call(arguments, 1) : ''); }
  function warn(msg) { console.warn('%c[Nexus:sw]', 'color:#f97316;font-weight:700', msg, arguments.length > 1 ? Array.prototype.slice.call(arguments, 1) : ''); }
  function err(msg)  { console.error('%c[Nexus:sw]', 'color:#ef4444;font-weight:700', msg, arguments.length > 1 ? Array.prototype.slice.call(arguments, 1) : ''); }
  return { log: log, warn: warn, err: err };
})();
L.log('SW script evaluating', self.location.href);

// Import config before the engine so self.__scramjet$config is ready on construction.
// The worker is hosted below the CDN package path, so never resolve these from
// the origin root.
var _nexusBase = new URL('./', self.location.href).pathname;
importScripts(_nexusBase + 'config.js');

var _p = ['q', '9vx/'].join('');
var _f = ['sj', '.all', '.js'].join('');
importScripts(_nexusBase + _p + _f);
L.log('scramjet bundle imported');

var _lw = ['$', 'scr', 'amjet', 'Load', 'Worker'].join('');
var _sw = ['Scr', 'amjet', 'Service', 'Worker'].join('');

// ── Guaranteed IDB schema (must run BEFORE the constructor below) ────────
// Multiple call sites in the imported bundle open "$scramjet" at version 1,
// but only ONE of them actually passes an `upgrade` callback that creates
// the five object stores. Several others — including one fired
// unconditionally, unawaited, with no try/catch, straight out of the
// ScramjetServiceWorker constructor we're about to call below — open the
// same db/version with NO upgrade callback. Whichever open() call reaches
// a nonexistent "$scramjet" database first wins the one-time
// onupgradeneeded event; if it's a callback-less one, the db is permanently
// stuck at version 1 with zero stores, and everything downstream throws
// "NotFoundError: ... object store was not found" forever (upgrade() can't
// re-run without a version bump we don't control). This isn't a staleness
// issue — deleting and recreating the db just re-rolls the same coin flip.
//
// Fix: issue our own open() call, WITH the correct upgrade callback, right
// here, synchronously, before `new _exports[_sw]()` gets a chance to queue
// its callback-less one. IndexedDB processes open requests for the same db
// in the order they were issued (not the order their callbacks fire), so
// calling this first — even though it's async — guarantees we win. This is
// also mirrored in embed.html for the page-side race, and is safe to run
// unconditionally on every load since an already-correctly-schemaed db at
// a matching version is a no-op.
(function ensureScramjetSchema() {
  try {
    var req = indexedDB.open('$scramjet', 1);
    req.onupgradeneeded = function (ev) {
      var db = ev.target.result;
      ['config', 'cookies', 'redirectTrackers', 'referrerPolicies', 'publicSuffixList'].forEach(function (name) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      });
      L.log('IDB schema created/verified from SW (won the race against Scramjet\'s own no-upgrade-callback open calls)');
    };
    req.onsuccess = function (ev) {
      try { ev.target.result.close(); } catch (e) {}
    };
    req.onerror = function () {
      L.err('SW-side IDB schema-guarantee open failed', req.error);
    };
  } catch (e) {
    L.err('SW-side IDB schema-guarantee threw synchronously', e);
  }
})();

var _exports = self[_lw]();
var _engine = new _exports[_sw]();
L.log('ScramjetServiceWorker constructed (this is where bare-mux\'s SW-side SharedWorker port request kicks off)');

// _preloadPromise is used by ensureConfig() — resolved immediately since
// config arrives via the 'loadConfig' postMessage from ScramjetController.init()
var _preloadPromise = Promise.resolve();

var _pref = _nexusBase + 'math/';
var _legacyPref = _nexusBase + 'afsd123k2/';
var _svgEmbed = _nexusBase + 'embed.svg';
var _hydrated = false;
var _configPromise = null;

var _adblockHostPattern = /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.(com|co\.[a-z]{2})|googletagservices\.com|amazon-adsystem\.com|adsrvr\.org|adnxs\.com|criteo\.com|taboola\.com|outbrain\.com|pubmatic\.com|rubiconproject\.com|openx\.net|casalemedia\.com|33across\.com|sharethrough\.com|yieldmo\.com|moatads\.com|scorecardresearch\.com|quantserve\.com|adform\.net|zedo\.com|smaato\.net|smartadserver\.com|media\.net)$/i;
var _adblockCompatibilityHost = /(^|\.)(youtube\.com|youtube-nocookie\.com|ytimg\.com|googlevideo\.com|googleusercontent\.com|accounts\.google\.com|gstatic\.com)$/i;
function _isBlockedAdRequest(url) {
  try {
    var u = new URL(url);
    if (_adblockCompatibilityHost.test(u.hostname)) return false;
    return _adblockHostPattern.test(u.hostname);
  } catch (e) { return false; }
}

self.addEventListener('install', function (event) {
  L.log('install event');
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', function (event) {
  L.log('activate event');
  event.waitUntil(self.clients.claim());
});

function isAppShellRequest(request, url) {
  if (url.origin !== self.location.origin) return false;
  var path = url.pathname;
  if (path.indexOf(_pref) === 0) return false;
  if (path === _nexusBase || path === _nexusBase + 'index.html' || path === _nexusBase + 'index.svg' || path === _nexusBase + 'embed.svg' ||
      path === _nexusBase + 'embed' || path === _nexusBase + 'embed.html' ||
      path === _nexusBase + '1k123.js' || path === _nexusBase + 'config.js' || path === _nexusBase + 'worker.js' ||
      path === _nexusBase + 'cache-mgr.js') return true;
  if (path.indexOf(_nexusBase + 'assets/') === 0) return true;
  if (path.indexOf(_nexusBase + 'q9vx/') === 0) return true;
  if (path.indexOf(_nexusBase + 'm4thx/') === 0) return true;
  if (path.indexOf(_nexusBase + 'e7px/') === 0) return true;
  if (path.indexOf(_nexusBase + 'l9cx/') === 0) return true;
  if (path.indexOf(_nexusBase + 'httpbridge/') === 0) return true;
  if (path.indexOf(_nexusBase + 'hybrid/') === 0) return true;
  return false;
}

// The page-side Scramjet bundle contains its own BareMux copy. During a
// normal startup race it retries the SharedWorker handoff once per second,
// but the upstream bundle logs each retry as a warning. Keep the behavior and
// the real invalid-port error intact while moving only those known transient
// messages to debug level so the console remains usable.
async function quietScramjetRetryWarnings(response, url) {
  if (!response || !response.ok || url.pathname !== _nexusBase + 'q9vx/sj.all.js') return response;
  try {
    var source = await response.clone().text();
    var quiet = source
      .replace('console.warn("bare-mux: failed to get a bare-mux SharedWorker MessagePort within 1s, retrying")', 'console.debug("[Nexus:mux] SharedWorker port not ready after 1s; retrying")')
      .replace('console.warn("bare-mux: Failed to get a ping response from the worker within 1.5s. Assuming port is dead.")', 'console.debug("[Nexus:mux] worker ping timed out; recreating the port")');
    if (quiet === source) return response;
    var headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.delete('etag');
    L.log('quieted transient Scramjet/BareMux retry warnings in page bundle');
    return new Response(quiet, { status: response.status, statusText: response.statusText, headers: headers });
  } catch (error) {
    L.warn('could not quiet Scramjet/BareMux retry warnings; serving original bundle', error);
    return response;
  }
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function configReady(c) {
  return !!(
    c &&
    c.prefix &&
    c.files &&
    c.files.wasm &&
    c.files.all &&
    c.files.sync
  );
}

// NOTE: The Scramjet-internal ScramjetServiceWorker class ("_engine") has NO
// setConfig() method on the SW side — only the browser-side ScramjetController
// has that. On the SW side, config is a plain public field, set either by
// Scramjet's own internal message listener (this.config = e.config) or by
// its loadConfig() method, which reads from IndexedDB. We mirror that exact
// pattern here — direct field assignment, no setConfig calls.
//
// IMPORTANT: there used to be a reactive indexedDB.deleteDatabase('$scramjet')
// call here that fired when loadConfig() threw a stale-schema NotFoundError.
// It was removed — it self-deadlocked. The SAME loadConfig() call that just
// threw the error had already opened (and left open — scramjet's bundled IDB
// wrapper doesn't close it) a connection to "$scramjet". Trying to delete the
// database moments later, in that same SW, hit onblocked against scramjet's
// own just-opened connection — not "another tab" despite the browser's
// generic wording. Since we have no handle to close scramjet's internal
// connection, that delete request could never complete, and it kept
// lingering in the background blocking every subsequent indexedDB.open()
// call on "$scramjet" from anyone — a real deadlock, not just noise.
// The wipe now happens ONLY proactively, in embed.html, before any scramjet
// script has loaded and before anything has a connection open yet.

async function hydrateFromIdb() {
  if (configReady(_engine.config)) {
    _hydrated = true;
    L.log('hydrateFromIdb(): config already ready, skipping');
    return true;
  }
  L.log('hydrateFromIdb(): starting retry loop');

  for (var i = 0; i < 40; i++) {
    try {
      await _engine.loadConfig();
      if (configReady(_engine.config)) {
        _hydrated = true;
        L.log('hydrateFromIdb(): config ready after ' + (i + 1) + ' attempt(s)');
        return true;
      }
    } catch (e) {
      if (e && (e.name === 'NotFoundError' || (e.message && e.message.indexOf('object store') !== -1))) {
        // Stale "$scramjet" schema. Can't safely self-heal from here (see
        // note above) — this should have already been fixed by embed.html's
        // proactive wipe on page load. If you're seeing this, either that
        // wipe hasn't run yet for this build, or something re-created a
        // stale db after it ran. Bump NEXUS_IDB_SCHEMA in embed.html and
        // reload.
        L.err('hydrateFromIdb(): stale-schema NotFoundError — needs the page-side proactive wipe in embed.html, cannot self-heal from the SW', e.message);
      } else if (e) {
        L.warn('hydrateFromIdb(): loadConfig() attempt ' + (i + 1) + ' threw', e.message || e);
      }
    }
    await delay(50);
  }
  L.err('hydrateFromIdb(): exhausted 40 attempts, giving up');
  return false;
}

async function ensureConfig() {
  if (_hydrated && configReady(_engine.config)) return true;
  if (_configPromise) return _configPromise;

  _configPromise = hydrateFromIdb().finally(function () {
    _configPromise = null;
  });
  return _configPromise;
}

async function applyConfigMessage(data) {
  L.log('applyConfigMessage() — forcing fresh loadConfig()');
  // IMPORTANT: do NOT just assign _engine.config = data.config directly.
  // Scramjet's own loadConfig() does two things: (1) sets this.config, and
  // (2) calls a module-level global sync — (0,c.Nk)(this.config) — that its
  // OWN deep internals (the handleFetch/"m" function that actually performs
  // the proxied fetch) read from directly via a separate global ($W), NOT
  // via this.config. Setting this.config by hand skips that global sync
  // entirely, so this.config looks "ready" to our own checks and to
  // route()/the outer fetch() guard, but the deep internals still crash
  // reading undefined.$W.prefix.
  //
  // The browser side (ScramjetController.init()) already awaits writing the
  // config into IndexedDB BEFORE it posts this message, so instead of using
  // the message payload directly, we treat the message purely as a
  // "config should be available now, go get it properly" signal and force
  // a real loadConfig() call, which performs the full correct sync.
  _engine.config = undefined;
  _hydrated = false;
  await ensureConfig();
}

function unwrapAppUrl(pathname) {
  // Detects recursively re-encoded application URLs, e.g.:
  //   /math/http%3A%2F%2Flocalhost%3A3000%2Fmath%2Fhttps%253A%252F%252Fgithub.com...
  // This happens if the engine ever resolves a relative URL against the
  // application's own origin instead of the real page origin, and re-encodes an
  // already-proxied URL as if it were a fresh absolute URL to wrap.
  // Peels off nested layers until it reaches the real destination URL.
  if (pathname.indexOf(_pref) !== 0) return null;
  var decoded;
  try {
    decoded = decodeURIComponent(pathname.slice(_pref.length));
  } catch (e) {
    return null;
  }
  var current = decoded;
  for (var i = 0; i < 8; i++) {
    var inner;
    try {
      inner = new URL(current);
    } catch (e) {
      break;
    }
    if (inner.origin === self.location.origin && inner.pathname.indexOf(_pref) === 0) {
      try {
        current = decodeURIComponent(inner.pathname.slice(_pref.length));
      } catch (e) {
        break;
      }
    } else {
      break;
    }
  }
  return current !== decoded ? current : null;
}

function isTopLevelDocumentNavigation(request) {
  if (!request || request.mode !== 'navigate') return false;
  // Request.destination is "document" for the browser's top-level address
  // bar navigation and "iframe" for ScramjetFrame.go(). Keep the header check
  // as a Firefox/older-browser fallback.
  return request.destination === 'document' || request.headers.get('sec-fetch-dest') === 'document';
}

function encodeBase64Url(value) {
  var bytes = new TextEncoder().encode(String(value));
  var binary = '';
  for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeApplicationTarget(pathname, prefix) {
  if (pathname.indexOf(prefix) !== 0) return null;
  var current = pathname.slice(prefix.length);
  for (var i = 0; i < 8; i++) {
    try { current = decodeURIComponent(current); } catch (_) { return null; }
    if (/^https?:\/\//i.test(current)) {
      try {
        var target = new URL(current);
        return target.protocol === 'http:' || target.protocol === 'https:' ? target.href : null;
      } catch (_) { return null; }
    }
  }
  return null;
}

function directEmbedRedirect(event, url) {
  if (!isTopLevelDocumentNavigation(event.request) || url.origin !== self.location.origin) return null;
  var target = decodeApplicationTarget(url.pathname, _pref) || decodeApplicationTarget(url.pathname, _legacyPref);
  if (!target) return null;
  var redirectTo = self.location.origin + _svgEmbed + '#b64.' + encodeBase64Url(target);
  L.warn('top-level application navigation detected; returning to SVG embed shell', {
    from: url.pathname,
    to: redirectTo,
    destination: event.request.destination,
  });
  return Response.redirect(redirectTo, 302);
}

async function handleRequest(event) {
  var url;
  try {
    url = new URL(event.request.url);
  } catch (e) {
    return fetch(event.request);
  }

  // A browser address-bar navigation can land directly on Scramjet's encoded
  // /math/ route. That route is meant for the inner browsing frame, not as a
  // top-level document, so return it to the SVG shell with the destination in
  // the hash. Inner iframe navigations are left alone because their fetch
  // destination is "iframe", not "document".
  var directRedirect = directEmbedRedirect(event, url);
  if (directRedirect) return directRedirect;

  // Accept links produced by an older build and move them to the current
  // route. This prevents stale tabs/bookmarks from becoming a 404 after the
  // route name changes.
  if (url.origin === self.location.origin && url.pathname.indexOf(_legacyPref) === 0) {
    try {
      var legacyTarget = decodeURIComponent(url.pathname.slice(_legacyPref.length));
      var legacyDestination = self.location.origin + _pref + encodeURIComponent(legacyTarget) + url.search;
      return Response.redirect(legacyDestination, 302);
    } catch (_) {}
  }

  // Same-origin request that ISN'T under our application prefix, but originated
  // from a page we ARE rendering: this is the classic "leaked native
  // navigation" bug. Native browser mechanisms — form submissions,
  // target="_top" links resolved by the browser's own C++ internals,
  // window.open, etc. — read the DOM's underlying attribute value
  // directly, bypassing every JS-level Object.defineProperty trap
  // Scramjet installs. A relative action/href that was never rewritten
  // then resolves against OUR real origin instead of the site being
  // proxied, landing here with no prefix at all.
  //
  // Recovery: decode a known-good "current page" URL back to the real
  // page origin, splice the leaked path+query onto it, and redirect into
  // the correctly prefixed application URL.
  //
  // decodeIfPrefixed() includes a critical guard: if decoding a candidate
  // "current page" URL yields a real origin that is STILL our own origin,
  // we refuse to use it. Without this guard, if the referrer itself is
  // already corrupted (e.g. left over from an earlier failed navigation in
  // the same session), we would faithfully "recover" into a URL that
  // points right back at ourselves, wrapping it again and producing
  // exactly the kind of self-referencing loop this fix exists to prevent.
  if (url.origin === self.location.origin && url.pathname.indexOf(_pref) !== 0) {
    L.warn('possible leaked native navigation detected (same-origin, unprefixed)', url.pathname);
    function decodeIfPrefixed(candidateUrl) {
      if (!candidateUrl) return null;
      var u;
      try { u = new URL(candidateUrl); } catch (e) { return null; }
      if (u.origin !== self.location.origin) return null;
      if (u.pathname.indexOf(_pref) !== 0) return null;
      try {
        var decoded = decodeURIComponent(u.pathname.slice(_pref.length));
        var realOrigin = new URL(decoded).origin;
        if (realOrigin === self.location.origin) return null; // still self-referencing — reject
        return decoded;
      } catch (e) {
        return null;
      }
    }

    var realPageUrl = null;

    // Primary source: the Referer header on this exact request.
    realPageUrl = decodeIfPrefixed(event.request.referrer);

    // Fallback: the referer can be stale, truncated by a Referrer-Policy on
    // the proxied site itself, or (as seen in practice) already corrupted
    // from an earlier bad navigation. The live client list reflects the
    // frame's actual current location and is more reliable — walk all open
    // window clients and use the first one whose URL decodes to a real,
    // non-self-referencing origin.
    if (!realPageUrl) {
      try {
        var clients = await self.clients.matchAll({ type: 'window' });
        for (var ci = 0; ci < clients.length; ci++) {
          var candidate = decodeIfPrefixed(clients[ci].url);
          if (candidate) { realPageUrl = candidate; break; }
        }
      } catch (e) {}
    }

    if (realPageUrl) {
      try {
        var realOrigin2 = new URL(realPageUrl).origin;
        var recovered = realOrigin2 + url.pathname + url.search;
        var redirectTo = self.location.origin + _pref + encodeURIComponent(recovered);
        L.log('leaked-navigation recovered, redirecting', { from: url.pathname, to: redirectTo });
        return Response.redirect(redirectTo, 302);
      } catch (e) {
        L.err('leaked-navigation recovery threw while building redirect', e);
        // Fall through to normal handling below
      }
    } else {
      L.warn('leaked-navigation could not be recovered — no usable referrer or window client found, falling through');
    }
    // If we get here, we couldn't safely recover — fall through and let
    // this request be handled normally (will most likely 404 cleanly,
    // which is safe; it will NOT create a redirect loop).
  }

  // Fix recursively-wrapped application URLs before routing through the engine.
  // We rebuild a real FetchEvent (spec-constructable) pointed at the
  // corrected single-encoded URL, and pass THAT into the exact same
  // _engine.route()/_engine.fetch() calls used below — same interface,
  // same behavior, just a corrected URL.
  if (url.pathname.indexOf(_pref) === 0) {
    var realUrl = unwrapAppUrl(url.pathname);
    if (realUrl) {
      var fixedUrl = self.location.origin + _pref + encodeURIComponent(realUrl);
      L.warn('recursively-wrapped application URL detected, unwrapping', { from: url.pathname, to: fixedUrl });
      try {
        var fixedRequest = new Request(fixedUrl, {
          method: event.request.method,
          headers: event.request.headers,
        });
        event = new FetchEvent('fetch', { request: fixedRequest });
        url = new URL(fixedUrl);
      } catch (e) {
        L.err('failed to rebuild FetchEvent for unwrapped URL, continuing with original', e);
        // FetchEvent construction failed — fall through and let the
        // request continue with its original (wrapped) URL rather than
        // crashing; the application engine will likely 404 it cleanly.
      }
    }
  }

  var ready = await ensureConfig();
  if (!ready || !configReady(_engine.config)) {
    L.warn('config not ready for request', url.pathname);
    if (url.pathname.indexOf(_pref) === 0) {
      return new Response('Application engine not ready', { status: 503, statusText: 'Service Unavailable' });
    }
    try {
      return await fetch(event.request);
    } catch (e) {
      return new Response('Network error', { status: 502 });
    }
  }

  try {
    if (_engine.route(event)) {
      return await _engine.fetch(event);
    }
  } catch (e) {
    L.err('_engine.fetch() threw', url.pathname, e);
    if (url.pathname.indexOf(_pref) === 0) {
      return new Response('Request failed', { status: 502 });
    }
  }

  try {
    return await fetch(event.request);
  } catch (e) {
    return new Response('Network error', { status: 502 });
  }
}

self.addEventListener('fetch', function (event) {
  try {
    var url = new URL(event.request.url);
    if (isAppShellRequest(event.request, url)) {
      event.respondWith(
        fetch(event.request).then(function (res) {
          // Firefox refuses to let a service worker respondWith() a
          // navigation/document fetch event using a Response whose
          // `redirected` flag is true (e.g. because the underlying fetch()
          // auto-followed an upstream redirect, like a dev-server "clean
          // URL" redirect stripping .html). It throws "A ServiceWorker
          // intercepted the request and encountered an unexpected error"
          // instead of just using it. Chrome doesn't care, which is why
          // this only showed up on Firefox. Fix: rebuild a fresh, non-
          // redirected Response with the same body/status/headers before
          // handing it to respondWith().
          if (res.redirected) {
            L.warn('app-shell request was redirected upstream, rewrapping response to satisfy Firefox', url.pathname, '->', res.url);
            return res.body
              ? new Response(res.body, res)
              : res.clone();
          }
          if (url.pathname === _nexusBase + 'q9vx/sj.all.js') {
            return quietScramjetRetryWarnings(res, url);
          }
          return res;
        }).catch(function (e) {
          L.err('app-shell passthrough fetch failed', url.pathname, e);
          return new Response('Network error', { status: 502 });
        })
      );
      return;
    }
  } catch (e) {}
  event.respondWith(handleRequest(event));
});

var playgroundData;
self.addEventListener('message', function (msg) {
  var data = msg.data;
  if (!data) return;
  if (data.type === 'playgroundData') {
    playgroundData = data;
  }
  if (data.scramjet$type === 'loadConfig') {
    L.log('received loadConfig postMessage from a client', {
      sourceId: msg.source && msg.source.id ? msg.source.id : null,
      sourceUrl: msg.source && msg.source.url ? msg.source.url : null,
      hasController: !!(msg.source && msg.source.id),
    });
    var p = applyConfigMessage(data);
    if (typeof msg.waitUntil === 'function') {
      try {
        msg.waitUntil(p);
      } catch (e) {}
    }
    // Reply once config is actually applied, so the page can wait for a
    // real confirmation instead of racing a fire-and-forget postMessage.
    // This closes the race that caused "Cannot read properties of
    // undefined (reading 'prefix')" when a navigation fired before the
    // SW had finished processing the config message.
    p.then(function () {
      var ready = configReady(_engine.config);
      L.log('replying configAck', {
        ready: ready,
        sourceId: msg.source && msg.source.id ? msg.source.id : null,
        sourceUrl: msg.source && msg.source.url ? msg.source.url : null,
      });
      if (msg.source) {
        try {
          msg.source.postMessage({ nexus$type: 'configAck', ready: ready });
        } catch (e) {}
      }
    }).catch(function (error) {
      L.err('loadConfig apply failed before configAck', {
        sourceId: msg.source && msg.source.id ? msg.source.id : null,
        message: error && error.message ? error.message : String(error),
      });
    });
  }
});

_engine.addEventListener('request', function (e) {
  if (_engine.config && _engine.config.adblockEnabled && e.url && _isBlockedAdRequest(e.url.href)) {
    L.log('built-in ad blocker blocked request', e.url.href);
    var blockedHeaders = { 'content-type': 'text/plain' };
    // A 204 response cannot have a body. Passing an empty string makes
    // Chromium throw and aborts the service-worker fetch handler.
    e.response = new Response(null, { status: 204, headers: blockedHeaders });
    e.response.rawHeaders = blockedHeaders;
    e.response.rawResponse = { body: null, headers: blockedHeaders, status: 204, statusText: 'No Content' };
    e.response.finalURL = e.url.toString();
    return;
  }
  if (playgroundData && e.url.href.indexOf(playgroundData.origin) === 0) {
    var headers = {};
    var origin = playgroundData.origin;
    if (e.url.href === origin + '/') {
      headers['content-type'] = 'text/html';
      e.response = new Response(playgroundData.html, { headers: headers });
    } else if (e.url.href === origin + '/style.css') {
      headers['content-type'] = 'text/css';
      e.response = new Response(playgroundData.css, { headers: headers });
    } else if (e.url.href === origin + '/script.js') {
      headers['content-type'] = 'application/javascript';
      e.response = new Response(playgroundData.js, { headers: headers });
    } else {
      e.response = new Response('empty response', { headers: headers });
    }
    e.response.rawHeaders = headers;
    e.response.rawResponse = {
      body: e.response.body,
      headers: headers,
      status: e.response.status,
      statusText: e.response.statusText
    };
    e.response.finalURL = e.url.toString();
  }
});
